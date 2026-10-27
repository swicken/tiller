# Installing Tiller

On a Mac, clone the repo and run:

    bin/setup

It checks everything tiller needs, lists what is missing with the exact command for each, asks once, installs those pieces, then runs `npm ci` (installing the locked dependencies without changing `package-lock.json`), `npm link` and `npm run app:build`. It never uses `sudo` and does not edit your shell profile.

- `bin/setup --no-app` skips Rust and the app build.
- `bin/setup --harness pi` installs Pi instead of Claude Code when neither is present. Claude Code is not needed for a Pi-only tree.
- `tl doctor` (or `bin/setup --check`) reruns the checks later without changing anything and prints the fix for anything broken.

For Codex nodes, have `codex` on your PATH and authenticate with `codex login`; see the [Codex adapter](../adapters/codex/README.md). The setup installer currently offers Claude Code or Pi.

## What setup checks

- macOS with the Xcode Command Line Tools (`xcode-select --install`), which Tauri needs to build the native app.
- Homebrew, and Node 24 or newer (`brew install node`).
- An agent CLI on your PATH: `claude` (Claude Code, `curl -fsSL https://claude.ai/install.sh | bash`), or `pi` 1.2.x or 1.3.x (`npm install -g @earendil-works/pi-coding-agent@~1.3.0`). See [harnesses.md](harnesses.md) for Pi setup and limitations.
- Rust, through Homebrew's rustup: `brew install rustup`, then `"$(brew --prefix rustup)/bin/rustup" default stable`, which installs the stable toolchain and leaves your shell profile alone. That rustup is keg-only, so `cargo` is not on your PATH by default; `bin/setup` and `bin/tl-app` add it themselves. To run `npm run app:build` or `cargo` from your own shell, add `export PATH="$(brew --prefix rustup)/bin:$PATH"` to `~/.zshrc`.
- Optional: `terminal-notifier` (`brew install terminal-notifier`), so clicking a macOS notification selects the node.
- `tl` on your PATH pointing at this checkout. `npm link` puts `tl` (the client), `tld` (the daemon in the foreground) and `tl-app` (the native app) there; if you have another tiller checkout linked, `tl doctor` says where `tl` points.
- The built app, `src-tauri/target/release/bundle/macos/Tiller.app`. The first build compiles the Rust dependencies and takes a few minutes. Without it, `tl` opens the browser UI instead, and `tl-app` runs the app in dev mode. Rebuild after pulling changes to `ui/` or `src-tauri/` (`npm run app:build`, or rerun `bin/setup`).

To keep updates available, leave the primary checkout on a clean `main` and develop on task branches in separate worktrees; see [updating a checkout](releases.md#updating-a-checkout).
