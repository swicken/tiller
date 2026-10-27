# Working on Tiller

Tiller runs Claude Code, Pi and Codex sessions as child processes of a local Node.js daemon. A React UI is shared by the browser and the macOS Tauri app.

## Repository map

- `src/daemon/`: node lifecycle (`manager.ts`, `nodes.ts`, `pty.ts`), HTTP/WebSocket server (`server.ts`), CLI (`cli.ts`), agent tools (`mcp.ts`), messaging, worktrees, sessions and updates.
- `src/shared/`: daemon/UI contracts in `protocol.ts` and shared pure helpers.
- `adapters/pi/` and `adapters/codex/`: harness bridges; `src/daemon/harness.ts` defines the adapter boundary and launch policy. Each adapter has its own README.
- `mod/`: Claude Code plugin; `mod-rows/` is its companion plugin that draws received messages. See `mod/README.md` for hook restrictions and its separate test runner.
- `ui/`: React + xterm.js. `App.tsx` composes the shell; `sidebar/`, `settings/`, `dialogs/`, `release-notes/` and `transcript/` group features, and `controls/` holds reusable components and icons. `store.ts` holds shared UI state; component state stays with its owner. See `ui/README.md` for the module map, styles and mock daemon workflow.
- `src-tauri/`: native Rust app shell and Tauri configuration.
- `docs/`: behavior and configuration references, indexed in [docs/README.md](docs/README.md). `PLAN.md` and `docs/design/` contain historical design rationale; check current code and behavior docs when plans differ.
- `spike/`: manual experiments using real sessions and local daemons, described in [spike/README.md](spike/README.md); these are separate from automated tests.

## GitHub pull requests and merges

- Make changes on task branches. Integrate worker branches into the task branch, not `main`.
- Deliver changes through a GitHub pull request. Push the task branch and open or update its PR when authorized to publish the work.
- Merge into `main` through GitHub after required checks and reviews pass. Do not merge or fast-forward local `main` to deliver changes, and do not push directly to `main`, unless the user explicitly requests an exception to this workflow.
- Treat requests such as "merge into main" as requests to merge the PR on GitHub, not as instructions for a local merge followed by a direct push. Sync local `main` from GitHub afterward.
- Report the PR link, check status, and GitHub merge result clearly; distinguish local commits from pushed changes and merged PRs.

## Setup and development

Use Node.js 24+ and npm from the repository root. `npm ci` installs the locked dependencies; keep lifecycle scripts enabled because `postinstall` fixes the macOS `node-pty` spawn helper. Native app development also needs Rust and Xcode Command Line Tools; see `README.md` for setup.

- `npm run ui:dev`: Vite with hot reload; `/ws` proxies to the daemon at `127.0.0.1:7788`, or `TL_WS` when set.
- `npm run ui:build`: build static assets into `ui/dist/`.
- `npm run app:dev`: run the Tauri development shell.
- `npm run app:build`: build the macOS app, including the UI build.

The default daemon uses `~/.tiller` and port 7788. For manual daemon experiments, use a separate `TL_HOME` and `TL_PORT` so they do not share live node state. `bin/setup` also installs tools, links the checkout and builds the app; use `npm ci` for dependency setup alone.

## Verification

Run checks appropriate to the changed area from the repository root:

| Area | Command |
| --- | --- |
| Daemon, shared code, Codex and Pi adapters | `npm run typecheck` |
| UI and its shared imports | `npx --no-install tsc --noEmit -p ui/tsconfig.json` |
| Vitest suite (daemon, shared, adapters, UI) | `npm test` |
| Focused Vitest run, for example messaging | `npm test -- src/daemon/messaging.test.ts` |
| Claude mod | `claude plugin validate mod/` and `claude plugin test mod/`; the same for `mod-rows/` |
| Release helpers | `node --test scripts/release-test.mjs` |
| Native Rust app | `cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml` |

Tests generally live beside their source as `*.test.ts` or `*.test.tsx`. Keep daemon integration tests isolated with temporary homes and ephemeral ports, as in `src/daemon/server.test.ts`. Vitest runs up to one test file per two CPU cores at once (at least two) to bound resource use for tests that create real git repositories and child processes. `mod/` and `mod-rows/` tests run only through the Claude plugin runner.

Implementation workers must run relevant focused tests for their changes and report the commands and results. Reviewers run targeted checks as needed to assess the diff; read-only analyses do not need broad testing. The orchestrator runs the full Vitest suite (`npm test`) once on the final integrated tree before publication.

`.tiller/config.json` defines an automatic worker completion gate: `npm run typecheck` (root and Pi adapter) plus the UI typecheck. The gate does not select or run focused tests. Workers' focused tests and the orchestrator's integration checks remain required manual checks; passing the gate does not replace them.

`.github/workflows/ci.yml` remains the authoritative CI reference: it checks types, the full Vitest suite, release helpers, the production UI build and Rust on macOS. The worker gate does not cover every CI check.

## Conventions and boundaries

- TypeScript is strict and uses ES modules. Match nearby formatting (daemon/UI code generally uses single quotes and semicolons; Pi uses double quotes). NodeNext code uses `.js` import specifiers for local TypeScript modules; the Pi adapter uses `.ts` specifiers and a separate tsconfig.
- Keep daemon/UI message contracts in `src/shared/protocol.ts`. Preserve the distinction between Tiller session IDs and harness-native conversation IDs when changing adapters or persistence.
- Keep coordination, scope checks and delivery receipts in the daemon; adapters bridge native lifecycle events and inbox delivery. Consult the adapter READMEs before changing acceptance/acknowledgment behavior.
- In the Claude mod, code using `$` belongs in `mod/hooks/register.tsx`; imported helpers cannot receive `$`. The mod cannot import `src/shared/`.
- Update the relevant behavior docs when changing CLI, configuration, messaging or lifecycle behavior. For release/updater changes, read `docs/releases.md` and the updater sections of `README.md`.
