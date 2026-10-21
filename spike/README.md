# Manual experiments

These scripts exercise real Claude sessions and local daemons. They are manual experiments, outside Vitest and the worker completion gate; they can incur API usage and create node state or processes. They are not required verification for a structural cleanup.

| Script | Purpose |
| --- | --- |
| `e2e.ts` | Real Claude launch, terminal interaction and lifecycle checks against a separately started daemon. |
| `e2e-orch.ts` | Real orchestrator/worker messaging and delivery receipts against a separately started daemon. |
| `restart-check.ts` | Queued-message survival across a daemon stop and restart; starts and stops its own daemon. |
| `docker-remote/` | A Linux daemon in a container, reached from the host over a non-loopback address: `docker build -f spike/docker-remote/Dockerfile -t tiller-spike .` then `docker run -d --name tiller-spike tiller-spike`. Terminal nodes only; no agent CLIs and no credentials in the image. Needs `TL_BIND`. |
| `pty-holder/` | A detached PTY holder and a client that is killed and replaced while a real `claude` or `vim` keeps running; `client.ts launchd` checks survival of a launchd bootout with a temporary job. No daemon. See [design/pty-holder.md](../docs/design/pty-holder.md). |

Read each script's header and implementation before running it. Use a fresh, isolated `TL_HOME` and an unused `TL_PORT`, as described in the script. Do not point these experiments at the live daemon or an existing session home.

For automated verification, use the commands in [AGENTS.md](../AGENTS.md#verification). UI development without live agents is covered by the [mock daemon workflow](../ui/README.md#developing-without-the-daemon).
