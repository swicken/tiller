# Tiller Codex adapter

Run an authenticated [Codex CLI](https://learn.chatgpt.com/docs/app-server) on your PATH:

```sh
tl --harness codex
tl new "Codex worker" --harness codex --prompt "Inspect the tests"
```

Codex also appears in the spawn dialog and accepts `harness: "codex"` with `kind: "agent"`
on the existing spawn MCP tool. Generic agent children inherit their parent's harness.
Tiller does not install Codex or handle login; run `codex login` yourself first.
`tl doctor --harness codex` checks the executable and advertised `--remote` / app-server
`--listen stdio://` capabilities without starting a server or accessing your account.

The daemon launches `codex app-server --listen stdio://` and the real Codex TUI. A private
Unix-socket WebSocket bridge connects `codex --remote` to that same app-server.
It uses Codex's own models, authentication, instructions, sandbox, and approval settings.
Tiller's role prompt is supplied as `developerInstructions`. Explicit model and effort overrides
are supported (`low`, `medium`, `high`, `xhigh`); omitted values keep Codex's defaults.
Explicit effort seeds only a fresh native thread, including restart or an untouched-session
fallback that actually creates a new thread. Inbox turns, reload/resume, and fork/follow-up
preserve native effort settings, including changes made with the model picker. The native TUI
also omits the original effort override when attaching an existing thread. Tiller retains the
original effort in node metadata for fresh starts; saved native effort controls attached threads.
Explicit model overrides still reapply on resume/fork; that existing model policy is unchanged.
Claude role model defaults are not applied. Claude `permissionMode`, preset `tools`,
`disallowedTools`, `maxTurns`, and spawn `fork` are rejected.

## Terminal controls

The terminal pane is the native Codex CLI, including its composer, slash commands, model picker,
streaming tool output, and native approval/input dialogs. Tiller forwards the app-server protocol;
it does not render a replacement UI or accept approvals on your behalf. Codex's own settings
still control which actions require approval.

Use Codex's normal terminal controls. Tiller's inbox bridge submits queued messages directly to
the same session and confirms native acceptance. Changing the managed conversation with native
new/fork/resume commands is refused; use Tiller's restart/follow-up controls instead.

When asked for workers/subagents, the Codex-specific coordination instructions explicitly use
Tiller's MCP `spawn` tool (`kind: "agent", harness: "codex"`). Codex's internal `spawn_agent`
creates internal sessions that are not Tiller nodes. The native subagent tools are not disabled,
but Tiller workers must use the Tiller tools to appear in the tree.

## Coordination and persistence

A uniquely named required HTTP MCP server (`tiller_<48-bit random suffix>`) points to Tiller's `/mcp`.
The recognizable prefix appears in Codex's MCP tool identity while the random suffix prevents collisions.
It authenticates using the node's token, read from `TL_TOKEN_FILE`, through an environment header; the token is never
placed on the command line. Tiller's existing tools and lineage restrictions are reused.

The bridge serializes lifecycle reports from `turn/started`, `turn/completed`, item events,
and token-usage notifications through `/hook` and `/mod-event`. Context usage is reported, and so
are account quota windows, read once when the native UI attaches and updated from Codex's
rate-limit notifications (see [Account quotas](#account-quotas)); dollar cost is not
available from this adapter.
A report the daemon cannot take, for example during `tl reload` or `tl update`, is retried
every second for up to 60 seconds, holding later events so reports stay in order. After that
the report is logged and dropped, and later reports are tried once each until the daemon
answers again. A daemon outage never closes the Codex session.

Inbox messages remain queued and withdrawable while busy. A steer interrupts once and runs
first after completion. The bridge claims only immediately before `turn/start`, and acknowledges
only after the app-server returns a turn id. A failed receipt retries the receipt, never the
prompt. An explicit native rejection releases the claim; an ambiguous transport failure closes
the host and leaves the claim to retire as unconfirmed. Inherited claims are retired without
replaying them. The daemon bounds unresolved claims at 60 seconds. Do not automatically resend
an unconfirmed message: it may already have run.

On shutdown, inbox intake stops first. Native stdout gets up to 250 ms to drain buffered
notifications after termination; the bridge then stops event intake and has an overall 5-second
budget for lifecycle reports and pending receipts. Individual failed receipts do not block the
others. At the deadline, outstanding HTTP/native requests are canceled and accepted local
transcript events still drain; undelivered lifecycle reports cannot be guaranteed when the
daemon is unavailable. Unknown claims remain unconfirmed for daemon retirement, never replayed
or falsely acknowledged. Native events not written to stdout before termination, or arriving
after the 250 ms cutoff, cannot be retained. A forced process kill can bypass all cleanup.

The host tracks the native TUI and app-server through their spawned child handles. Shutdown sends
TERM, escalates after 250 ms to KILL, and waits up to another second for each actual exit event.
Closed stdio and a successful signal return are not exit confirmation. Both children must have
exited before the host exits. If termination remains unconfirmed, the host stays alive until the
child exit events arrive, so a harness change fails closed rather than starting another agent.
This does not extend the 250 ms stdout cutoff or the bridge's five-second receipt budget.

The bridge writes readable normalized JSONL transcripts under
`sessions/<rootId>/agents/<nodeId>/<Tiller-sessionId>.jsonl`. The header stores Codex's separate
native thread id; Tiller's session identity stays stable. Resume uses `thread/resume`, restart
starts a new thread, and follow-up copies the transcript into the new tree and uses `thread/fork`
so it cannot append to the archived thread. Prior readable transcripts are copied too.
Codex retains the native conversation under its own home; deleting that native history prevents
resume/follow-up even when Tiller's readable transcript survives. The readable transcript is not
a replacement for Codex's native tool and reasoning history.
Codex does not persist a native rollout for an untouched session; an empty session whose native
rollout is absent is recreated on resume/follow-up. Recorded conversations are never replaced.

Worktree nodes start in their managed working directory. Tiller's repository-command trust
guard remains advisory; see [Worktrees and safety](../../docs/harnesses.md#worktrees-and-safety).
Cross-harness spawning follows the same delegation guard as Pi: a restricted Claude parent
cannot bypass its restrictions by selecting Codex. A Codex parent may spawn Codex children.

The node-scoped HTTP client is shared with Pi in `adapters/shared/client.ts`. The readable
transcript header format/parser lives in `src/shared/codex-transcript.ts`; transcript path
selection and adoption remain in the daemon.

## Account quotas

`adapters/codex/bridge.ts` reads account quotas once when the native UI attaches
and starts inbox polling. The read runs without blocking startup. Account quota
notifications are handled before thread filtering because they are account-scoped.
Both paths publish through the bridge's shutdown-deadline wrapper; usage transport
failures never stop the agent. A completed background read is not published after
shutdown begins.

`readCodexUsage` issues exactly one read on the existing RPC connection, with a
2-second deadline. Invoke it without `await` so it never blocks startup. It never
starts an app-server, thread or turn, and returns `{ usageUnavailable: true }` on
RPC failure, timeout, or a response without reportable quota windows. Publishing
that measure retains prior snapshots and marks them stale/unavailable. Publishing
must also be caught separately so HTTP telemetry failures cannot call the bridge's
fatal handler. There is no automatic retry or recurring quota probe.

`CodexUsage.measure(payload)` returns `{ usageReports }` for real quota windows,
or `{ usageUnavailable: true }` for unavailable data. `reports(payload)` remains
available for normalization alone. Keep one instance for the bridge lifetime so
sparse updates preserve unrelated pools and account identity; a reported account
switch clears prior-account pool state. Neither method fabricates model-specific
quotas or converts token counts, credits or dollar balances into quota use.

The manager derives tool identity from the authenticated node, including Codex.
The native generated protocol was inspected locally with:

```sh
codex app-server generate-ts --out /tmp/tiller-usage-codex-protocol
```

Relevant generated contracts: `v2/GetAccountRateLimitsResponse.ts`,
`v2/AccountRateLimitsUpdatedNotification.ts`, `v2/RateLimitSnapshot.ts`,
`v2/RateLimitWindow.ts`, and `v2/SpendControlLimitSnapshot.ts`. Read responses
support `rateLimitsByLimitId`, fallback `rateLimits`, and optional `accountId`.
Rolling updates are sparse and omit account metadata. `normalModelSlug` describes
a quota alias and does not prove a model-exclusive quota. Unix reset timestamps
are seconds. Credits and dollar balances are not quota percentages.

## Validation

The protocol subset was checked against generated bindings from `codex-cli 0.162.1` and the
official app-server documentation. The installed CLI was also exercised for initialization,
required node-scoped MCP inventory, thread creation, and native TUI attachment. There is no strict version gate; unsupported APIs fail visibly.

A live spawn check through the node-scoped MCP tool also launched a visible Codex child,
delivered a no-tools diagnostic prompt, and recorded its model response.

`npm test` covers the real host and daemon with a fake app-server: launch, delivery receipts,
streaming/lifecycle, context, approvals, steering, transcript retention, resume/restart/follow-up,
and delivery failures. These tests do not perform provider-backed inference.
