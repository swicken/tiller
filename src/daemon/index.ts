import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_ID } from '../shared/protocol.js';
import { treeOrder } from '../shared/tree.js';
import { loadConfig } from './config.js';
import { daemonPort, PORT_FILE, REPO_FILE } from './home.js';
import { terminalBundleFor } from './launch.js';
import { createNotifier, findBin, runDetached } from './notifier.js';
import { NodeManager } from './manager.js';
import { loginShellPath } from './pty.js';
import { startServer } from './server.js';
import { logError } from './util.js';

const path = await loginShellPath();
const manager = new NodeManager({ path });
const server = await startServer(manager, { port: daemonPort(manager.home) }).catch((err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Another daemon has the port, such as when `tl autostart on` loads the agent beside a running one. Exit 0 so
  // launchd's KeepAlive (relaunch only on failure) leaves it at that.
  console.log(`port ${daemonPort(manager.home)} is in use: another daemon is running; exiting`);
  process.exit(0);
});
const tl = fileURLToPath(new URL('../../bin/tl', import.meta.url));
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const notifier = createNotifier({
  view: (id) => manager.view(id),
  tree: (id) => {
    const root = manager.view(manager.registry.lineage(id).at(-1)?.id ?? id);
    return root ? treeOrder(manager.list(), root).map((i) => i.node) : [];
  },
  config: (id) => { const rec = manager.registry.get(id); return loadConfig(rec ? manager.projectDir(rec) : null, manager.home).notifications; },
  dnd: server.dnd,
  watchers: server.watchers,
  appConnected: server.appConnected,
  notifyNative: server.notifyNative,
  terminalNotifier: process.env.TL_TERMINAL_NOTIFIER ?? findBin('terminal-notifier', `${path}:/opt/homebrew/bin:/usr/local/bin`),
  terminalBundle: process.env.TL_TERMINAL_BUNDLE ?? terminalBundleFor(process.env.TERM_PROGRAM),
  // A click runs this under sh with a bare PATH, so hand it the daemon's home and PATH.
  onClick: (id) => id.startsWith(APPROVAL_ID) ? 'true' : `TL_HOME=${sq(manager.home)} PATH=${sq(path)} ${sq(tl)} select ${id}`,
  run: runDetached,
});
server.onApproval = notifier.approval;
manager.on('notify', notifier);
manager.on('node', notifier.observe);
manager.on('removed', (id: string) => {
  notifier.forget(id);
  for (const node of manager.list()) if (node.parentId === null) notifier.recheck(node);
});
writeFileSync(join(manager.home, PORT_FILE), `${server.port}\n`); // lets `tl` find the daemon without TL_PORT
writeFileSync(join(manager.home, REPO_FILE), fileURLToPath(new URL('../..', import.meta.url))); // lets the Tauri app find bin/tld
if (process.env.TL_DEBUG) manager.on('hook', (id, ev) => console.log(`${new Date().toISOString().slice(11, 23)} hook ${id.slice(0, 6)} ${JSON.stringify({ e: ev.hook_event_name, err: ev.error, tool: ev.tool_name, type: ev.notification_type, prompt: (ev.prompt_id as string | undefined)?.slice(0, 6), msg: ev.message, mode: ev.permission_mode })}`));
// Never log the admin token: this goes to daemon.log. `tl url` prints the full URL on request.
console.log(`tiller daemon listening on ${manager.endpoint} (run tl url for the browser UI's URL)\nhome: ${manager.home}`);

// Clear worktrees a crash left with no work in them and report the rest; then resume the nodes that were live.
manager.worktrees({ clean: 'startup' }).then((r) => {
  for (const x of r.removed) console.log(`removed orphaned ${x.what}`);
  if (r.orphans.length || r.kept.length) console.log(`${r.orphans.length} orphaned worktree(s) and ${r.kept.length} kept branch(es): see tl worktrees`);
}).catch(logError).then(() => manager.resumeLive()).then(console.log, logError);

// Delete expired session directories now and once a day.
const sweepSessions = () => { try { for (const id of manager.sweepSessions()) console.log(`removed expired session directory ${id}`); } catch (err) { logError(err); } };
sweepSessions();
setInterval(sweepSessions, 86_400_000).unref();

process.on('unhandledRejection', logError);

function stop(): void {
  manager.shutdown().then(() => server.close()).catch(logError).finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
