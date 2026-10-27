# Documentation map

Use the behavior references for current contracts and configuration:

| Area | Reference |
| --- | --- |
| Configuration keys, defaults and scope | [config.md](config.md) |
| Harness adapters, launch policy, repository trust, Claude accounts and usage quotas | [harnesses.md](harnesses.md) |
| Message delivery, steering and receipts | [messaging.md](messaging.md) |
| Roles, task profiles, presets, outcomes and gates | [agent-roles.md](agent-roles.md) |
| Worktree creation, merging and closing | [worktrees.md](worktrees.md) |
| Session storage, event log, restart and resume | [sessions.md](sessions.md) |
| Memory: opt-in, what is recorded, trust, limits | [memory.md](memory.md) |
| Browser, macOS app and notifications | [frontends.md](frontends.md) |
| Releases and updater | [releases.md](releases.md) |

The [repository guide](../AGENTS.md) maps source directories and verification commands. The [UI guide](../ui/README.md) maps feature modules and explains the mock daemon workflow; adapter and [Claude mod](../mod/README.md) guides live beside their code.

[future-plan.md](future-plan.md) ranks planned work. [PLAN.md](../PLAN.md) and [design/](design/) record historical design rationale. Check the current code and behavior references when a plan differs. [spike/](../spike/README.md) contains manual experiments, separate from the automated test suites.
