# Source releases

Every push to `main` starts [Release](../.github/workflows/release.yml). It calls
the same reusable [CI workflow](../.github/workflows/ci.yml) used for pull
requests, then publishes only if validation succeeds. The checkout, tag and
release target all use that push event's full SHA (`github.sha`), including on
reruns. Moving `main` while validation runs cannot change the release source.
There is no manual-dispatch shortcut around validation.

## Updating a checkout

This section covers the consumer side: how a Tiller checkout finds and installs these releases.

`tl update --check` checks published stable GitHub releases and prints the latest version and notes for every missed release. `tl update` installs that exact release, rebuilds changed dependencies/UI/app and restarts the daemon. Before the restart it waits for agents to finish their turns (the app shows "Waiting for N agents to finish their turn" with **Restart now**; `tl update --now` skips the wait); live nodes then resume under the configured resume policy, and any whose turn was cut off is told to continue. If the checkout already contains the latest release but the daemon is still running older code, release management offers **Rebuild and restart** from the clean `main` checkout. After an installed release is detected, the footer's **What’s new** notice shows its unread release notes and disappears when read. When a future release is discovered, the footer shows **Update available**; select it to review release notes and explicitly install through release management. Installed unread notes remain separate under **What’s new**. No dialog opens and no update installs automatically. If the native app is rebuilt, quit and reopen Tiller.

Updates use the GitHub repository identified by the checkout's `origin` (HTTPS or git SSH). Only published, non-draft, non-prerelease `vX.Y.Z` releases qualify; unreleased commits on `main` are never an update target. While at least one authenticated app or browser is connected, one daemon-owned checker runs immediately when stale and then two minutes after each successful check. Closing the last UI pauses automatic checking; reconnects share the same freshness window. Manual checks remain available. Failures back off from twenty minutes to six hours, and GitHub rate-limit headers pause requests until the server allows retries. Release-list requests use ETags when available; no local GitHub tokens are sent. A failed/offline/rate-limited check disables applying until a successful check; there is no cached-main fallback. Release versions are compared numerically, and skipped release notes are rolled up newest first. Release dialogs render authored Markdown and show change descriptions first, with the complete original generated notes available under collapsed **Technical details**. Releases without PR descriptions use actual non-merge commit subjects; full commit SHAs remain in the technical record.

Installed unread notes are separate from update availability. The first daemon observation establishes a baseline without a notice, including when offline. Later checks show notes only when the running daemon is at an exact published stable release commit; development commits and an old daemon whose checkout moved do not count. Notes for skipped releases are rolled up newest first from that baseline. The baseline and proven unread notes persist in `<TL_HOME>/update-notes.json`, so reconnects, restarts, and multiple UI clients share read state. Notes-file mutations briefly serialize across daemon instances; an interrupted `<TL_HOME>/update-notes.json.lock` leaves notes unchanged and reports its path. Confirm no notes writer is active before manually removing that lock. Reading acknowledges the exact displayed identity; an older acknowledgment cannot dismiss newer notes. Proven cached notes remain readable offline, while missing release metadata waits for a successful check and never guesses notes from main or a package version.

Updating is human-only and requires the primary checkout on `main`, no uncommitted or untracked files, no git operation in progress, and an ancestor relationship allowing a fast-forward to the release. Local or unreleased commits are preserved by refusing the update. Linked worktrees and detached checkouts cannot apply updates. Tags and commits are pinned and checked again before applying, including release publication and notes; a changed target requires another review. No remotes are reconfigured or pushed.

Keep the primary checkout on clean `main` and do development on task branches in separate worktrees so updates remain available. If an update is disabled, release management shows the reason and recovery guidance. Uncommitted or untracked files are identified as an unclean `main` checkout; after fixing the checkout, check releases again to refresh its eligibility. Manual and automatic checks share daemon-owned progress; applying stays disabled while eligibility is refreshed. Updating restarts the daemon once agents have finished their turns, or at once with **Restart now** or `--now`. They can resume afterward; automatic resume follows `daemon.resumeOnStart`, the idle-age limit and session/worktree availability.

The detached helper logs to `<TL_HOME>/update.log` and holds a checkout-wide `.git/update.lock`, including while rebuilding and restarting. A failed update attempts `git reset --keep` to the original commit, reinstalls/rebuilds the steps it started, and verifies the restarted daemon's commit. Edits that prevent a safe rollback are retained and reported with the log path. An interrupted helper can leave the lock behind: inspect the log and checkout, confirm no helper is running, repair/rebuild if necessary, then remove the lock manually before retrying. Never remove a live helper's lock. This updater rebuilds a source checkout; it does not download prebuilt app assets.

## Skipping a release

Label a pull request `no-release` when it changes only tests or CI. Merging it
still runs full validation on `main`, and the publish job still runs, but before
allocating a version the script looks up the merged PR for the pushed SHA
(`GET /repos/{repo}/commits/{sha}/pulls`; the publish job holds
`pull-requests: read` for this). If that PR was merged into the released branch
and carries the label, the script logs `no release: #N is labelled no-release`
and succeeds without creating a tag or release. A labelled PR into another
branch, such as a task branch later merged into `main`, does not count. Direct
pushes have no PR and release as usual. A failed lookup fails
the job and publishes nothing. Do not use `[skip ci]` instead: it skips
validation on `main`.

Skipped commits are not lost. The next release's notes span the previous
published release to its own SHA, both GitHub's generated notes
(`previous_tag_name`) and the **Technical details** commit list, so they include
every skipped PR's commits.

## Version and updater contract

- A release is a published, non-draft, non-prerelease GitHub Release with a strict
  `vMAJOR.MINOR.PATCH` tag. With no such releases the first is `v0.1.0`.
- Each new validated source increments the numerically highest published stable
  version's PATCH. A deliberate major/minor baseline requires a separately
  reviewed release; commit messages do not control versions.
- The tag resolves to the exact validated commit. The producer creates a
  lightweight tag; existing annotated tags are also resolved to their commit.
  Existing tags are never moved or deleted by the script.
- A source updater discovers published stable releases through the GitHub
  Releases API, resolves the tag to its exact commit, and uses the release body
  as update notes. `target_commitish` may be a branch on older/manual releases
  and is not a source revision contract. There is no fallback to `main`.
- Releases contain source and notes. This workflow produces no signed binaries
  or updater asset manifest and does not bump package, Cargo or app manifests.

An automatic check that finds the same published releases, `origin` and
checkout HEAD as the last successful check reuses the tags that check resolved
instead of contacting `origin` again; it still reads the checkout's state and
`update.lock` afresh. Manual checks always resolve every tag again, and
installation validates the release and tag again before it changes anything.

Manual and automatic discovery share one in-flight check. The daemon broadcasts
`checking: true` with installation eligibility disabled at the start, then
`checking: false` with the fresh result or failure. Checks requested during
installation retain the current `applying` status without starting discovery.
The optional `blocker: 'dirty'` identifies a proven dirty primary `main`
checkout; other blockers and check failures retain the human-readable reason.
Automatic discovery skips while a live update helper holds the checkout's
`update.lock` and reports that in the reason. A lock whose recorded process has
exited no longer pauses discovery: checks continue and report the interrupted
update as the reason updates are blocked. The lock is never removed
automatically, including at daemon start; inspect `update.log` and the checkout,
then remove it. A lock without a readable pid is treated as live.
Installation restarts the daemon after building. The restart first waits for
agents to finish their turns, holding messages and spawns (see
[waiting for turns to end](sessions.md#waiting-for-turns-to-end)); agents
resume afterward under the existing [resume policy](sessions.md#resume-on-daemon-start).

The release body starts with GitHub-generated PR notes using an explicit previous
published stable tag. When GitHub returns only a compare link or no description,
it starts with actual non-merge commit subjects instead, without hashes. Subjects
are escaped as Markdown text; no summary is invented.

A collapsed native GitHub `<details>` block labeled **Technical details** retains
every commit subject and full SHA in
`previous-release-commit..validated-push-commit`, including merges, and the
validated source SHA. Its exact structure is `<details>`,
`<summary>Technical details</summary>`, a blank line,
`<!-- tiller-release-evidence:v1 -->`, a blank line, the `## Commits` appendix,
and `</details>`, each on its own line. The appendix has a blank line after its
heading, one `- <full SHA> <subject>` line per commit, a blank line, and
`Validated source: <full SHA>`. The body ends with a newline.

Both UI release dialogs show descriptions first and keep the complete original
body accessible as text under a collapsed **Technical details** disclosure. They
also recognize the exact older terminal `## Commits` / `Validated source`
appendix: PR notes take priority; compare-only notes fall back to commit subjects,
with standard merge scaffolding omitted from the primary view. Authored Markdown,
fenced examples and unknown formats remain untouched. This affects presentation
only; historical GitHub releases are not rewritten.

Direct commits and multiple merged PRs remain in the technical record. The first
release includes the entire history. Drafts, prereleases, non-semver tags and
unpublished tags do not establish the notes baseline. GitHub notes generation
must succeed before any tag is created.

## Repository setup

1. Enable GitHub Actions and permit the workflow's job-level `contents: write`
   token permission. The workflow default and reusable validation job have only
   `contents: read`; only the publication job gets write access. It needs no PAT,
   inherited secrets, PR write permission or signed-binary credentials. Checkout
   does not persist credentials. Repository/organization policy can still deny
   the requested permission.
2. Protect `main` with required pull requests and the CI workflow's required
   checks. Require branches to be up to date, restrict bypasses, and disable
   force pushes/deletions. Merge queues additionally require configuring CI's
   `merge_group` event before enabling them.
   Require review for changes to `.github/workflows/` and `scripts/release.mjs`
   (for example with CODEOWNERS). Code merged into `main` will run with the
   publication job's token permission.
3. Protect `v*` tags against updates and deletion using repository rulesets.
   Allow this workflow's GitHub Actions identity to create tags and releases;
   do not grant unrelated writers a blanket bypass. Check organization rules
   before enabling automation: a rule blocking tag creation makes publication
   fail. Consider enabling immutable releases to lock published tags and assets.
4. Confirm there is no other automatic publisher allocating these versions.
   Existing published stable releases must have valid tags in the ancestry of
   `main`. Existing `v0.1.0` without a release must either point to the first
   validated source or be resolved by a maintainer before automation starts.

The source release job uses Node 24 and git on an Ubuntu GitHub-hosted runner;
it installs no npm dependencies. `GITHUB_TOKEN` writes do not normally start
other Actions workflows, so downstream automation must not assume a tag push or
release event produced here triggers another workflow.

## Serialization and failures

The entire Release workflow uses one `release-main` concurrency group with
`cancel-in-progress: false` and `queue: max`. Validation and publication are
serialized together. GitHub allows at most 100 pending runs; further runs are
canceled. Runs queue by when they start waiting, which can differ from push
order. Do not change this to the default single-pending queue: that replaces
intermediate pushes. A canceled, failed or skipped validation cannot publish.

The script checks ancestry against the latest stable release. If a newer source
has already been published, an older or divergent unreleased SHA fails closed
instead of becoming the latest release. Its commits are already rolled into
the newer release if they are ancestors. Branch protection prevents divergent
history; a maintainer must investigate before changing the release baseline.

Normal reruns are idempotent:

- If the SHA already has a published stable release, the script succeeds without
  creating a version, even after later releases exist.
- If tag creation succeeded but publication failed, retry reuses the same next
  tag only if it resolves to that exact SHA. The release body is regenerated
  against the same previous published stable release.
- If publication succeeded but the API response was lost, retry discovers the
  published release and succeeds without another version.
- A different commit at the next tag, a draft/prerelease occupying the next
  version, a missing tag for a published stable release, API/permission failure,
  or invalid ancestry stops publication. No conflict is silently overwritten or
  skipped by allocating another version.

## Recovery

Inspect the failed workflow run and release/tag state first. Fix failed checks,
token policy or ruleset configuration, then use **Re-run all jobs** on the
original push's Release run. This revalidates that same event SHA. A newer push
is independently validated and includes changes since the last published
release; it may safely supersede an earlier failed run.

If a failed run left an unpublished next-version tag, rerun that original SHA
before another source publishes. A subsequent different SHA will stop on the
tag conflict. A maintainer must explicitly decide whether to complete the
original release or remove the orphaned *unpublished* tag after verifying its
origin; this workflow never removes it. A conflicting draft requires maintainer
review as well. Do not move or delete published tags. Do not manually create a
release to bypass failed validation.

For runs canceled by queue overflow, rerun the original push workflow. If newer
source is already published, check whether its notes include the canceled
source; the ancestry guard prevents an older release from replacing it. Notes
over 125,000 bytes stop before tag creation; unusually large first histories
need a reviewed baseline release rather than silently truncating notes.

## Local verification

These checks use temporary local git repositories and an in-memory GitHub API;
they never create remote tags or releases:

```sh
node --check scripts/release.mjs
node --test scripts/release-test.mjs
```

The tests cover first release, the `no-release` label, numeric PATCH
allocation, notes boundaries, pagination, exact SHA and annotated tags,
publication failure/retry, reruns, conflicts, stale source rejection and API
failures. The Release workflow runs
them before publication. Actual GitHub permissions, rulesets and queue behavior
require a live authorized run; local tests do not exercise those policies.
Actionlint 1.7.12 predates GitHub's `concurrency.queue` support and reports that
key as unknown. When using that version, ignore only its specific unexpected
`queue` key diagnostic; validate the queue setting against the GitHub reference
below and keep all other diagnostics enabled.

## GitHub references

- [Reusable workflows](https://docs.github.com/en/actions/how-tos/sharing-automations/reuse-workflows)
- [Concurrency queue and ordering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Release API and generated notes](https://docs.github.com/en/rest/releases/releases)
- [Git reference API](https://docs.github.com/en/rest/git/refs)
- [Token permissions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication)
- [Events caused by GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
