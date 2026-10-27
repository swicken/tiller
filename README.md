<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="tiller" width="320">
  </picture>
</p>

# tiller

You ask one agent for something. It splits the work across agents running in parallel, each in its own git worktree, has the result reviewed, and hands you one integrated branch to open as a pull request. The agents are Claude Code, Codex or Pi sessions on your machine; you watch and steer them from a macOS app or the same UI in a browser.

## What a run looks like

A real run from Tiller's own development. You type two requests to the orchestrator:

> do prune audits of this repo, split sensibly, and give me the data
>
> send workers to resolve what was found

1. The orchestrator spawns 8 read-only auditors in parallel, one per code or test slice. They report 90 findings with evidence.
2. It spawns 7 fixers, each owning separate files, each in a worktree on a branch from one task branch.
3. Two independent reviewers check the diffs. They find a real bug, which goes back to its fixer.
4. The orchestrator merges the fixed branches into the task branch and hands it to you.

Partway through, the orchestrator's `list_nodes` shows the tree like this (abridged; ids and titles are illustrative):

```
- n-1a2b "prune audit" [agent claude] working 2h
  - n-3c4d "audit: daemon lifecycle" [agent claude] done (reported succeeded) 1h
  - n-5e6f "fix: daemon dead code" [agent claude] done (reported succeeded) 20m ⎇ tl/n-5e6f from tl/prune ↑3 merged
  - n-7a8b "fix: test fixtures" [agent claude] working 3m ⎇ tl/n-7a8b from tl/prune ↑1 dirty
  - n-9c0d "review: fixer diffs" [agent claude] working 5m
```

What you got: one PR to `main`, about 94 files and +600/−700 lines, with 83 findings fixed and 6 skipped with reasons. The full test suite went from about 55 s to about 25 s.

## What you look at day to day

**What did I ask for?** Each root you start is a session: the sidebar shows its tree, and the session switcher moves between trees. **History** in the sidebar lists closed nodes you can read, follow up or fork. From a shell, `tl ps` prints the same tree and `tl sessions` lists every tree's notes directory.

**What needs me?** An agent's request to merge or close opens an **Agent request** dialog with Approve and Deny. In the sidebar, rows show `blocked`, `Needs changes` for a failed outcome, `no activity` for a stalled worker, `conflicts with base`, and on a collapsed parent `N needs you`. The daemon sends a macOS notification when an agent needs your input or approval and when a whole tree finishes; the Dock badge counts blocked or waiting nodes, and the menu bar dot turns amber. Coming back after a while opens a **While you were away** card. See [front ends and notifications](docs/frontends.md).

**What is ready to review?** A worker that finished shows `outcome succeeded` on its row, and the last-message panel shows its report. A worktree with unmerged work shows `changes · N ahead · M dirty`. The **Diff** tab (or `tl diff <id>`) shows what it changed and lets you send line comments back; **Transcript** shows its conversations. Merges go into the task branch, never into `main`; you push that branch and open the PR yourself. See [worktrees](docs/worktrees.md).

## Install

On a Mac, clone the repo and run:

    bin/setup

It checks for the Xcode tools, Node 24+, an agent CLI and Rust, offers to install what is missing, then installs dependencies, links `tl` and builds the app. `tl doctor` reruns the checks. The full list, flags and Codex setup are in [docs/install.md](docs/install.md).

## Everyday commands

| Command | What it does |
| --- | --- |
| `tl` | Start the daemon if needed and open the app (or the browser UI if the app is not built). |
| `tl .` or `tl ~/repo` | Open the app on that directory's orchestrator, creating it if there is none. Add `--harness pi` or `--harness codex` to use those ([harnesses](docs/harnesses.md)). |
| `tl --new` | Start a fresh orchestrator for the current directory (or a given path). |
| `tl reload` | Restart the daemon on the current code and resume live nodes, after waiting for turns to end ([details](docs/sessions.md#waiting-for-turns-to-end)). |
| `tl stop` | Stop the daemon and every node; nothing resumes on the next start. |
| `tl update` | Install the latest stable release and restart; `--check` only looks ([details](docs/releases.md#updating-a-checkout)). |
| `tl doctor` | Check what Tiller needs and print the fix for anything missing. |

`tl url` prints the browser UI's address with its token, `tl autostart on` starts the daemon at login ([autostart](docs/sessions.md#autostart)), and `tl help` lists every command and flag.

## Concepts

You rarely need these directly; the orchestrator uses them.

- **Nodes**: each agent session or terminal the daemon runs. A root node is an orchestrator; a node it spawns is a worker ([agent roles](docs/agent-roles.md)).
- **Roles and profiles**: the orchestrator coordinates and delegates; workers do one scoped task and report an outcome ([agent roles](docs/agent-roles.md)).
- **Harnesses**: the agent CLI a node runs, Claude Code, Codex or Pi, bridged by a mod, extension or app-server adapter ([harnesses](docs/harnesses.md)).
- **Messages**: nodes talk through the daemon, which queues, delivers and steers them ([messaging](docs/messaging.md)).
- **Worktrees and task branches**: parallel workers get their own worktree on a branch from one task branch; merges go into that branch, never into `main` ([worktrees](docs/worktrees.md)).
- **Gates**: a configured check, such as `npm test`, that must pass before a worker's success report counts ([completion gate](docs/agent-roles.md)).

## Where files live

The daemon keeps its state under `~/.tiller` (or `TL_HOME`) and listens on 127.0.0.1:7788 (or `TL_PORT`). Each tree has a session directory, `sessions/<rootId>/`, for notes and the event log. Details, including how `tl` picks a daemon from inside a node, are in [sessions](docs/sessions.md#where-files-live).

## Configuration

Tiller reads an optional per-repo `<repo>/.tiller/config.json`, which you commit, and an optional global `~/.tiller/config.json`; the repo file wins key by key, edits apply without a restart, and `tl config` shows the effective values. Every key is in [docs/config.md](docs/config.md); role prompts and spawn presets are in [docs/agent-roles.md](docs/agent-roles.md).

## Known limits

- Anthropic can disable mods remotely, and `--bare` or `--safe-mode` drop them. The daemon and CLI still work then; messages are pasted into the terminal instead.
- Claude shows its trust dialog the first time it opens a new folder; attach and accept it.
- One daemon per user.
- With autostart on, a daemon started by `tl` or the app (when none was running) runs outside launchd, so a crash does not bring it back until the next `tl reload` or login.

## Development and tests

Use Node.js 24+ and run `npm ci` from the repository root. `npm run ui:dev` starts Vite with hot reload against the daemon; [ui/README.md](ui/README.md) covers the mock daemon. Run `npm run typecheck` and `npm test` before a pull request. [AGENTS.md](AGENTS.md#verification) lists every check and the contribution workflow, and [GitHub CI](.github/workflows/ci.yml) is the reference.

## Documentation

[docs/README.md](docs/README.md) indexes the behavior references: [install](docs/install.md), [configuration](docs/config.md), [harnesses](docs/harnesses.md), [messaging](docs/messaging.md), [agent roles](docs/agent-roles.md), [worktrees](docs/worktrees.md), [sessions](docs/sessions.md), [front ends](docs/frontends.md) and [releases](docs/releases.md). [PLAN.md](PLAN.md) and [docs/design/](docs/design/) hold the design rationale.
