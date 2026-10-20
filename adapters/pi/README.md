# Tiller Pi adapter

A [Pi](https://pi.dev) extension that makes an interactive `pi` CLI process a first-class
[Tiller](../../README.md) node. It mirrors the Claude Code mod in `mod/` but uses Pi's extension
API instead of Claude hooks.

The extension is a thin bridge: it forwards Pi lifecycle data to the Tiller daemon and delivers
Tiller inbox messages into Pi. It does **not** reinterpret permissions, change the tool set, or
spawn processes.

```
 adapters/pi/
   index.ts      extension factory (loaded by pi)
   bridge.ts     inbox poll / claim / submit / ack / steer state machine
   config.ts     TL_* environment parsing
   lifecycle.ts  pure Pi-event -> Tiller /hook and /mod-event mappers
   types.ts      structural subset of the Pi API (host supplies Pi)
   *.test.ts     vitest coverage for the pure helpers and the bridge
```

## Load it

The daemon launches Pi with an explicit session file and the extension's entry file, roughly:

```sh
TL_NODE_ID=n-abc123 \
TL_ENDPOINT=http://127.0.0.1:7654 \
TL_TOKEN_FILE=<home>/nodes/n-abc123/token \
TL_SESSION_ID=<tiller-session-uuid> \
TL_PI_HOOK_TOOLS=1 \
pi --session <home>/sessions/<rootId>/agents/n-abc123/<tiller-session-uuid>.jsonl \
  --name <title> [extension policy] --extension <repo>/adapters/pi/index.ts [tool policy] \
  --append-system-prompt <prompt>
```

The extension policy comes from the `pi.extensions` config: nothing for `"all"`, else
`--no-extensions --extension builtin:mcp --extension builtin:codemode --extension builtin:tool-search`
followed by `--extension <install path>` for each listed package. The tool policy comes from a
preset: `--tools` from its `tools` (always including `mcp__tl_<node prefix>_*`, this extension's server) and
`--exclude-tools` from its `disallowedTools`, translated from Claude tool names. Both are decided
in `piAdapter` (`src/daemon/harness.ts`); see `docs/harnesses.md`. The extension needs only
`builtin:mcp` for its own server with the default `direct` exposure; the `codemode` and
`deferred` exposures also need the codemode and tool-search built-ins. A preset's `tools`
allowlist does not add the `codemode` or `tool_search` tools, so under those two exposures
(`TL_PI_MCP_EXPOSURE`) a node with such a preset cannot reach Tiller's tools; keep the default
`direct` exposure for restricted presets.

`TL_SESSION_ID` is the daemon-minted Tiller session id. The bridge reports it as `session_id`,
never Pi's own header session UUID, because the node record, transcript path and resume all key
off the Tiller id.

Before a follow-up launches, the daemon copies its current transcript and any available recorded
prior sessions to the new node's own `sessions/<rootId>/agents/<nodeId>` directory. Pi's native
header UUID and Tiller's session id stay unchanged, preserving cost continuity and preventing two
live nodes from continuing the same session. Only the copied header's `cwd` is changed, to the
selected workspace or, when the node's worktree has been removed, the main checkout: native Pi
uses this header to choose resource discovery and built-in tool paths, even when launched from a
different directory. All conversation entries are copied
verbatim and the source archive is untouched. This also adopts older cross-root live records on
resume. The copied files follow the new tree's retention clock, including after it closes.
Missing source transcripts cannot be recovered; missing prior-session files remain missing.

You can also try it without a daemon:

```sh
pi --extension ./adapters/pi
```

Without `TL_NODE_ID` the extension loads but does nothing (the same inert contract as the Claude
mod). Pi loads the directory through `jiti`, so no build step is required.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `TL_NODE_ID` | yes | Node id; sent as `X-TL-Node`. Presence enables the bridge. |
| `TL_ENDPOINT` | yes | Daemon base URL, e.g. `http://127.0.0.1:7654`. |
| `TL_TOKEN_FILE` | yes | File holding the node bearer token (0600). |
| `TL_SESSION_ID` | no | The daemon-minted Tiller session id reported as `session_id`. Missing means unmanaged. |
| `TL_PARENT_ID` | no | Recorded but not otherwise used by the bridge. |
| `TL_SESSION_DIR` | no | Tiller session directory; not used by the bridge itself. |
| `TL_PI_POLL_MS` | no | Developer override, never set by the daemon. Inbox poll interval in ms, `>= 100`. Default `1000`. |
| `TL_PI_HOOK_TOOLS` | no | `1`/`true`/`yes`/`on` to forward tool activity as `/hook`. The daemon always sets `1`. |
| `TL_PI_MCP_EXPOSURE` | no | Developer override, never set by the daemon. MCP exposure for the node-scoped Tiller server: `direct` (default), `codemode`, `deferred`, `hidden`. |

## Protocol mapping

All calls use `Authorization: Bearer <token>` and `X-TL-Node: <nodeId>`.

| Pi event / API | Tiller call | Notes |
|---|---|---|
| `session_start` | `POST /hook` `SessionStart` | `session_id` (`TL_SESSION_ID`), `transcript_path` (from `--session`), `model`. |
| `session_start` | `pi.registerMcpServer("tl_<node-prefix>_<random>", …)` | HTTP MCP at `<endpoint>/mcp`, node-scoped headers. Fresh compact names (<=24 characters, 48-bit random suffix) prevent ordinary `mcp.json` entries named `tiller` from silently overriding the registration and leave provider tool-name headroom. |
| `before_agent_start` (`user`) | `POST /hook` `UserPromptSubmit` | The actual prompt Pi accepted; also the only source of bridge acceptance, so a void `sendUserMessage` return is never treated as delivered. |
| `agent_start` | `POST /mod-event` `turn.start` | Once per run (`{ text, turnId }`, informational), not per model turn. |
| `turn_end` | `POST /mod-event` `session.measure` | Context usage + cumulative session cost. |
| `agent_settled` | `POST /mod-event` `turn.complete` | The authoritative, final boundary. `aborted`, `durationMs`, `answer`, `usage.model`, and the final `stopReason` mapped to `reason` (`answer` / `aborted` / `error`). |
| `agent_settled` | `POST /mod-event` `session.measure` | See above. |
| `ui_prompt_start` | `POST /hook` `Notification` | `confirm` → `permission_prompt` (blocked); other kinds → `elicitation_dialog` (waiting). Only during an active run. |
| `ui_prompt_end` | `POST /hook` `PostToolUse` | Returns the node to working; paired with a mapped start (nested dialogs are counted). |
| `tool_execution_start` / `_end` | `POST /hook` `PreToolUse` / `PostToolUse` | Only with `TL_PI_HOOK_TOOLS`. Pi tool names/fields are mapped to the Claude names the daemon's reducer reads; the raw name stays in `pi_tool_name`. |
| `session_shutdown` (`quit`) | `POST /hook` `SessionEnd` | Await the queued hooks, then dispose the HTTP client. Other shutdown reasons replace the runtime and a new `session_start` follows. |
| `model_select` | `POST /mod-event` `session.measure` | Provider-qualified `model` (`provider/id`) including idle switches, so follow-up can replay the selected provider. |
| poll loop | `GET /inbox`, `POST /claim`, `POST /release`, `POST /ack`, `POST /unconfirmed` | See below. |

Every hook and mod-event is serialized through one in-process queue and awaited, so
`SessionStart` can never race the first turn's `turn.start` / `UserPromptSubmit`.

### Inbox, claim, ack, steer

On every poll (`pollOnce`, one in flight at a time):

1. A claimed message is submitted (or, if it was already submitted, its ack is retried).
2. `GET /inbox` is fetched.
3. At most **one immediate next** message is claimed, and only while Pi is idle. Everything else
   stays in the daemon (unclaimed) so its sender can still withdraw it.
4. While Pi is busy, a `steer` aborts the running turn once but stays unclaimed and withdrawable.
   When Pi is idle again it is claimed ahead of the queue.
5. A claimed message is submitted in the same cycle. If Pi turned busy between claim and submit,
   the bridge hands the claim back with `POST /release`: the message returns to the queue,
   withdrawable and retryable under the normal inbox TTL.

`POST /claim` returning `404` means withdrawn, expired, already claimed by a prior runtime, or
not persisted (the daemon undoes such a claim); never submit it. There is no `followUp`
fallback: Pi can combine queued prompts without an exact matching acceptance event.

Native `sendUserMessage` catches/logs prompt errors and returns **void**. Missing credentials,
compaction failure, and consumed input therefore need not throw or start a run. The bridge marks
`submitted` **before** calling it and never retries that call, even if a wrapper throws. Only an
exact matching `before_agent_start` confirms acceptance and permits `/ack`; ack failures retry
only the receipt. Pi does not use the daemon's Claude substring-hook acknowledgment.

A message that was submitted but never confirmed retires within **60 seconds from claim**,
independently of inbox TTL renewal. Retirement is conservative; this protocol does not prove
cancellation or delivery. The bridge uses `/unconfirmed`; the daemon also bounds Pi claims if the adapter stops polling.
Retirement removes the claim and reports `stalled`, `retryable: false`, with an explicit warning
that the prompt may still run later. **Do not resend automatically.** Later messages, including
steers, can progress; timeout is not cancellation, so late execution may change run ordering.
Late acceptance/ack cannot change the retired sender status to delivered or acknowledge a different
uniquely framed message. A lost retirement response retries retirement only.

Pi claims are persisted before `/claim` succeeds, are not re-claimable after reload/restart, and
are exposed as `claimed` in `/inbox`. A new bridge retires an inherited claim without replaying it.
Unconfirmed terminal statuses are saved with the inbox and retained for the normal status window.
If a claim disappears from the daemon, two consecutive misses release it locally without an ack.

## Pi API compatibility

Target: `@earendil-works/pi-coding-agent` **1.2.x and 1.3.x**. The adapter relies on:

- `pi.on("session_start" | "session_before_switch" | "session_before_fork" |
  "session_before_tree" | "session_shutdown" | "before_agent_start" | "agent_start" |
  "model_select" | "turn_start" | "turn_end" | "agent_end" | "agent_settled" |
  "ui_prompt_start" | "ui_prompt_end" | "tool_execution_start" | "tool_execution_end")`
- `pi.registerMcpServer` / `pi.unregisterMcpServer` (HTTP MCP config)
- `pi.sendUserMessage(content)` (no implicit native queue fallback)
- `ctx.isIdle()`, `ctx.abort()`, `ctx.getContextUsage()`, `ctx.sessionManager.getSessionId() /
  getSessionFile() / getEntries()`, `ctx.model`, `ctx.ui.notify`, `ctx.shutdown()`

The bridge reads the public host-supplied `VERSION` export and requires a stable **1.2.x or 1.3.x** version
before registering MCP or reading credentials. `pi.on` accepting an event name is not proof the
build emits it; the version gate pins the documented native event contract. Unknown, older, newer,
and prerelease versions fail closed. It also checks `registerMcpServer`, `unregisterMcpServer`,
`sendUserMessage`, `pi.on`, `ctx.isIdle`, `ctx.abort`, and `ctx.shutdown`. Optional UI/usage APIs
are not required.

`agent_settled` is the final boundary (`docs/extensions.md`): unlike `agent_end`, no automatic
retry, compaction, or queued continuation follows, so `turn.complete` is reported there.

`types.ts` declares the structural subset used. Only the compatibility gate imports the host's
public `VERSION` through Pi's supported extension module mapping; Tiller installs no Pi runtime.
`package.json` lists Pi as a host-provided peer dependency. Tests inject a version without
installing a second Pi runtime.

## Develop

Tests and typechecking run from the repository root:

```sh
npx vitest run adapters/pi adapters/shared
npx tsc -p adapters/pi/tsconfig.json
```

The shared HTTP client and its tests live in `adapters/shared/client.ts` and
`adapters/shared/client.test.ts`; both Pi and Codex use its node-scoped bearer auth.

The suite covers config parsing, the lifecycle
mappers, and the bridge state machine (idle delivery, daemon-held messages, steer abort, poll
non-overlap, timer cleanup, unconfirmed retirement, late acceptance/reload races, ack failure) with an injectable fake Pi and fetch.

### Managed sessions are protected

For a node launched by the daemon (`TL_SESSION_ID` set), Pi's own `/new`, `/resume`, `/fork` and
`/tree` would move the session id or file out from under the daemon, so `session_before_switch`,
`session_before_fork` and `session_before_tree` cancel them with a warning. If a Pi build ignores
the cancel and a `new`/`resume`/`fork` `session_start` still arrives, the bridge reports the error
and calls `ctx.shutdown()` instead of letting the managed UUID point at a different conversation.
`/reload` is still allowed: it restarts the extension runtime in place with the same session file.

## Safety boundary

The trust guard is advisory, not a sandbox; see [Worktrees and safety](../../docs/harnesses.md#worktrees-and-safety).

## Limitations

- Turn text for `turn.start` is the most recent user prompt seen by the extension; Pi's
  `agent_start` event does not carry it.
- `session.measure.cost` is derived from session entries the way Pi's `getSessionStats()` does.
  It is a snapshot; `rateLimits` are not available in Pi and are never reported.
- `turn.complete.reason` is `answer`, `aborted` or `error`: the final assistant message's
  `stopReason` (`aborted`/`error`) is mapped at `agent_settled`. Pi does not expose a distinct
  `refusal` reason.
- The 60-second confirmation deadline is conservative: a long compaction or delayed event may
  retire a prompt that eventually runs. Retirement does not cancel that prompt and cannot prove
  non-delivery. It prevents duplicate submission and queue wedges, not all late-run ordering.
  Native provider-backed delivery is not exercised by the offline/fake-Pi tests.
- `POST /focus` and the `tl-*` slash commands from the Claude mod are not ported here; the bridge
  only covers lifecycle, messaging, and MCP registration.
- The extension assumes the daemon supplies the session file via `--session`. It reads the path
  back from `ctx.sessionManager.getSessionFile()` rather than constructing it.
