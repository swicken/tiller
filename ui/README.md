# tiller UI

React + xterm.js front-end for the tiller daemon. It speaks the WebSocket protocol in `src/shared/protocol.ts`.

## Commands

- `npm run ui:build` writes the static UI to `ui/dist`; the daemon serves it at `/?k=<token>`.
- `npm run ui:dev` starts Vite with hot reload and proxies `/ws` to the daemon at 127.0.0.1:7788 (override with `TL_WS`).
- `npm test -- ui` runs the UI suite, including tests nested in feature folders. `npx --no-install vitest list ui --filesOnly` lists discovered test files.
- `npx --no-install tsc --noEmit -p ui/tsconfig.json` type-checks the UI recursively and its shared imports.

## Developing without the daemon

The mock daemon has three sessions (one with a blocked node and a pending command, one with an errored node, one idle), an exited node, and mixed models and context usage. Spawn, rename, resume, close and prune work in memory, and a confirm request arrives 15 seconds after connecting. History has four closed nodes across two trees; every Claude node has a fake transcript ("daemon" and the closed "auth refactor" have two sessions), and follow-up and fork make new nodes. Every agent node also has conversations: a child thread has a brief, tool-call turns, a queued-then-delivered message, a message without recorded text and an outcome; exited and closed children add a daemon notice, the closed "css tokens" a merge event, working children a still-queued message, and "tests" and "ui polish" a peer exchange. The new-session dialog lists three Claude accounts (one logged out, to show its login command); the dotcms-core session runs in the "work" account and its children inherit it.

    node ui/mock-server.mjs                                  # ws on :7789, token "mock"
    TL_WS=http://127.0.0.1:7789 npm run ui:dev               # then open the printed URL with ?k=mock

After `npm run ui:build` the mock also serves the built UI: open `http://127.0.0.1:7789/?k=mock`. Set `TL_MOCK_PORT` to change the port.

The mock supports **More actions → Change harness…** in memory, including mixed-harness session
labels. It starts no agent processes and requires no authenticated provider account.

## Usage readings

Claude session measurements currently provide limits without account identity. The Usage panel shows the newest unidentified session reading and keeps other readings in an expandable list, grouped only within the same provider, pool and model scope. This is a presentation of observations, not a claim that they share an account; windows are never combined across unidentified sessions. Readings the daemon stamps with a Tiller Claude account (home config `claude.accounts`) form one group headed "Account: <name>", and a node in that account shows it in the status bar before its own first report. Known accounts and pools stay separate, and the selected-node status bar keeps its own session readings. Each retained reading keeps its timestamps and unavailable/stale state. This presentation also works with existing daemons that send unidentified usage sources.

## URL and keyboard

- `?k=<token>` is stored in localStorage and removed from the address bar. `?node=<id>` selects that node and its session; the UI keeps it in step with the selection.
- Cmd+K jump to any node, Cmd+1..9 select the Nth row of the current session, Cmd+0 focus the sidebar tree.
- Cmd+Shift+[ and Cmd+Shift+] select the previous and next session tab, wrapping around; Cmd+Shift+1..8 select the Nth session tab and Cmd+Shift+9 the last. Cmd+Shift+Opt+[ and ] move the current tab left or right, as dragging does; the daemon saves the order. Left and right arrows move focus between tabs.
- With the tree focused: j/k or arrows move, h/l collapse and expand.
- Clicking terminal hyperlinks (including rendered Markdown links) opens HTTP/HTTPS URLs in your default browser in the app, or a new tab in the browser UI. File and custom-protocol links are not opened.

## Module map

```text
ui/
  App.tsx, main.tsx              shell composition and startup
  SessionTabs.tsx               session tabs along the top (the app's title bar strip)
  sidebar/                      tree, node rows, session switcher, inspector and resize
    tree.ts, sessions.ts        pure tree and session selection helpers
  settings/                     settings panel and edit model
  dialogs/                      application spawn, lifecycle and update dialogs
  release-notes/                release rendering, parser and historical fixtures
  transcript/                   conversations between nodes, full transcripts and archived node history
  controls/                     shared actions and their menu, metadata, rename, modal, select,
                                Markdown, external links and inline SVG icons
  store.ts, conn.ts             shared client state and daemon connection
  hooks.ts, notify.ts, tray.ts   document/native integration and notifications
  terminals.ts, TerminalPane.tsx terminal instances and their mounted surface
  worktree.ts                   hasChanges/canMerge predicates
  DiffPane.tsx, diff.ts          diff display and review comments
  theme.css, layout.css         theme variables and shared shell/pane styles
```

Other shell surfaces (session tabs, title/status bars, palette, activity, usage, toasts and last-message panel) remain at the top level. Tests, feature styles and private helpers live beside their owners; `fixtures.ts` supplies shared test nodes.

`store.ts` owns state shared across surfaces, including daemon snapshots, selection and open panes. Components keep local form, focus, resize and transient interaction state. Pure helpers and component tests cover both state transitions and rendered behavior.

Styles are plain CSS. `theme.css` defines the dark variables on `:root` and the light ones under `[data-theme='light']`; `theme.ts` resolves the viewer's `tl.theme` choice (System, Light or Dark; set in Settings and kept in this browser's or the app's own storage, not in the settings files) and sets the attribute, and an inline script in `index.html` sets it before first paint; `layout.css` retains shared pane rules, including transcript/archive styles. Feature and control styles live in their folders. Component stylesheet imports and the explicit global sequence in `main.tsx` preserve cascade order: theme, layout, sidebar, controls, activity.

See the [documentation map](../docs/README.md) for behavior references and [AGENTS.md](../AGENTS.md#verification) for the complete automated checks. The scripts in [spike/](../spike/README.md) are manual live-session experiments, not UI tests.
