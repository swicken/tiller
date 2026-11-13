# Manual experiments

These scripts exercise real Claude sessions and local daemons. They are manual experiments, outside Vitest and the worker completion gate; they can incur API usage and create node state or processes. They are not required verification for a structural cleanup.

| Script | Purpose |
| --- | --- |
| `e2e.ts` | Real Claude launch, terminal interaction and lifecycle checks against a separately started daemon. |
| `e2e-orch.ts` | Real orchestrator/worker messaging and delivery receipts against a separately started daemon. |
| `e2e-questions.ts` | A real agent asks the human a question with `ask_human`; checks it reaches a client and `tl questions`, survives a daemon restart, and that the answer sent afterwards reaches the agent, with the event log to match. Starts and stops its own daemon on a temporary home (`TL_E2E_HOME` to choose one; it ignores `TL_HOME`, which inside a node names the live daemon, and refuses a live home) and a free port; Claude on haiku by default, `--harness pi\|codex` for the others (Pi bills an OpenRouter account: get the owner's say-so first). |
| `restart-check.ts` | Queued-message survival across a daemon stop and restart; starts and stops its own daemon. |
| `pty-holder/` | A detached PTY holder and a client that is killed and replaced while a real `claude` or `vim` keeps running; `client.ts launchd` checks survival of a launchd bootout with a temporary job. No daemon. See [design/pty-holder.md](../docs/design/pty-holder.md). |

Read each script's header and implementation before running it. Use a fresh, isolated `TL_HOME` and an unused `TL_PORT`, as described in the script. Do not point these experiments at the live daemon or an existing session home.

For automated verification, use the commands in [AGENTS.md](../AGENTS.md#verification). UI development without live agents is covered by the [mock daemon workflow](../ui/README.md#developing-without-the-daemon).
