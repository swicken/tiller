import { applyUpdate, updateLocked, REPO, UPDATE_LOG } from './update.js';
import type { UpdateStatus } from '../shared/protocol.js';
// Thin client for the daemon's POST /api/<tool>. Inside a node it uses TL_NODE_ID / TL_TOKEN_FILE / TL_ENDPOINT, and
// refuses when TL_HOME / TL_PORT name another daemon; outside it acts as `human` with the admin token in <home>/admin-token.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { configEntries, effectiveProfileEntries } from './config.js';
import { gateFor } from './completion-gate.js';
import { promptPath } from './launch.js';
import { listPresets } from './presets.js';
import { SPAWN_FIELDS, spawnKind } from './spawnfields.js';
import { setProjectTrust } from './trust.js';
import { ADMIN_TOKEN_FILE, daemonPort as portFor, homeDir } from './home.js';
import { agentStatus, install, LABEL, TLD, plistPath, uninstall } from './autostart.js';
import { buildChildEnv, loginShellPath } from './pty.js';
import { formatEvent, listSessions, parseSince, readEvents, readNewEvents, sessionDir, type EventCursor, type SessionEvent } from './sessions.js';
import { fmtAge } from '../shared/format.js';
import { fmtUsd } from '../shared/spend.js';
import type { Harness, NodeKind } from '../shared/protocol.js';
import { mainCheckout, runCommands, WORKTREES_DIR } from './worktree.js';
import { cancelDrain, drainDaemon, restartDaemon, findDaemon, humanEnv, pickOrchestrator, spawnReload, startDaemon, upDir, type OrchestratorCandidate } from './up.js';

const usage = () => `tl: control tiller. With no arguments, start the daemon if needed and open the app; tl . opens it on this directory.

  tl [up|app]                                         start the daemon if needed and open the app on the existing sessions
  tl [up|app] PATH [--new] [--title T] [--prompt P] [--harness claude|pi|codex]  open the app on (or create) PATH's orchestrator;
                                                      --harness picks which agent CLI (default claude); without up/app, PATH
                                                      must start with . / or ~; any of these flags without a PATH means .
  tl url                                              print the browser UI's URL, which carries the admin token (not inside a node)
  tl status | stop                                    show or stop the daemon (tld runs it in the foreground); stop also means
                                                      the nodes are not resumed on the next start
  tl update [--check] [--now]                         check stable releases or install/build/restart at the latest release; the
                                                      restart first waits for agents to finish their turns, unless --now
  tl reload [--now]                                   restart the daemon on the current code and resume the nodes that were live;
                                                      first waits for agents to finish their turns (holding messages and
                                                      spawns meanwhile), unless --now; Ctrl-C stops waiting and cancels
  tl autostart on|off|status                          a launchd agent that starts the daemon at login and after a crash
  tl doctor [--no-app] [--harness claude|pi|codex]     check what tiller needs (bin/setup --check) and print the fix for anything missing
  tl new <title> [--cwd P] [--preset NAME] [--model M] [--effort E] [--prompt T] [--role R] [--profile P] [--harness claude|pi|codex] [--worktree [--base B]] [--account NAME]
                                                      start an agent node and show it in the app; --harness picks the agent CLI;
                                                      --account picks a Claude account from claude.accounts (default: by project)
  tl ps | list                                        show nodes
  tl usage                                            show account-level Claude usage (5-hour and 7-day windows) as nodes last reported it
  tl select <id>                                      show a node in the app (opens the app if it is built)
  tl resume <id>                                      relaunch an exited Claude node
  tl mute <id> | unmute <id>                          stop or restart OS notifications for one node
  tl dnd [on|off|1h|30m]                              do not disturb: no OS notifications until off, or for the time given;
                                                      with no argument, show whether it is on
  tl prune                                            remove every exited node that has no live descendant
  tl restart <id> [--prompt T]                        relaunch a node with a fresh session (clears its context; children are kept);
                                                      T is its first prompt, else it is pointed at the tree's handoff.md if any
  tl kill [--force] [--keep-branch|--discard] <id...> | close <id...>  close and delete nodes (an orchestrator needs --force);
                                                      a node's worktree must be clean and merged unless --keep-branch
                                                      (commit as WIP, keep the branch) or --discard (delete both)
  tl merge <id> [--close]                             merge a worktree node's branch into its base (refused on conflict,
                                                      naming the paths); --close then closes the node
  tl diff <id> [--stat]                               what a worktree node changed since it branched, committed or not
  tl send [--now] <id> "text"                         --now interrupts the target's turn if it is working (a steer)
  tl withdraw <messageId>                             take back a queued message that has not been delivered yet
  tl read <id> [outcome|summary|transcript|terminal] [--lines N]   (all but terminal also read a closed node)
  tl history [--root ID] [QUERY]                      closed Claude nodes, newest first, of one tree or all; QUERY filters by
                                                      title, first prompt or last message
  tl transcript <id> [--session SID]                  a live or closed node's conversation; SID picks one of its earlier sessions
  tl followup <id> --prompt P [--title T]             continue a closed node's session as a new node that starts on P
  tl spawn --kind claude|agent|terminal [--harness claude|pi|codex] --title T --cwd PATH [--prompt P] [--model M] [--effort low|medium|high|xhigh|max] [--permission-mode M] [--role orchestrator|worker|none] [--profile orchestrator|implementation|explorer|mechanical|reviewer] [--worktree [--base B]] [--preset NAME] [--request-id ID]
           [--after ID,ID] [--after-success ID,ID] [--now] [--fork ID] [--account NAME]
                                                      --harness pi|codex implies --kind agent when --kind is omitted; --after / --after-success
                                                      arm the node until those finish a turn or report
                                                      succeeded; --now launches past daemon.maxWorking instead of queueing;
                                                      --fork starts from a copy of a live or closed node's conversation (cwd: its);
                                                      --base names the branch the worktree forks from and merges into;
                                                      --account picks a Claude account for a root node (human only; children inherit)
  tl prompts                                          show the role prompt files and any override for this directory
  tl presets [--cwd P]                                list the spawn presets in effect for a directory and the file each comes from
  tl trust [--cwd P] | untrust [--cwd P]             allow or revoke repo setup/teardown and completion-gate commands (human only)
  tl config [--cwd P]                                 show the effective config for a directory and which file each key came from
  tl gate [--cwd P]                                   run the configured completion gate command once in a directory and print the result
  tl worktrees [--cwd P]                            list node worktrees, orphans and kept branches for this repo
  tl worktrees clean [--force] [--cwd P]              remove orphans and kept branches that are clean and merged; --force removes all
  tl sessions                                         list session directories (<home>/sessions/<rootId>) with title, age, size and closedAt
  tl sessions clean                                   delete the ones daemon.sessionsKeepDays has expired now
  tl sessions path [id]                               print the session directory of a node's tree (default: this node's, or this directory's orchestrator's)
  tl log [id] [--since 2h] [--follow]                 print a tree's event log (for a non-root id, only that node's events)
  tl help`;

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

const home = homeDir();
const adminToken = () => readFileSync(join(home, ADMIN_TOKEN_FILE), 'utf8').trim();
const daemonPort = () => portFor(home);

/**
 * Inside a node, why TL_HOME / TL_PORT name a different daemon from the node's own (whose home holds TL_TOKEN_FILE and
 * which listens at TL_ENDPOINT), else undefined. A node inherits its daemon's TL_HOME and TL_PORT, so they disagree
 * only when someone redirected them, and silently using either daemon could act on the wrong one.
 */
function daemonConflict(env: NodeJS.ProcessEnv): string | undefined {
  const local = `http://127.0.0.1:${daemonPort()}`;
  if (resolve(env.TL_TOKEN_FILE!).startsWith(resolve(home) + sep) && (env.TL_ENDPOINT ?? local) === local) return;
  return `tl: TL_HOME/TL_PORT name the daemon with home ${home} at ${local}${env.TL_PORT ? ' (port from TL_PORT)' : ''}, but this node `
    + `(${env.TL_NODE_ID}) belongs to the daemon at ${env.TL_ENDPOINT} with its token at ${env.TL_TOKEN_FILE}; refusing to guess which you mean. `
    + "Drop the override to address this node's daemon, or run tl without TL_NODE_ID, TL_TOKEN_FILE and TL_ENDPOINT "
    + '(and the inherited TL_PORT) to act as the human on the other.';
}

async function call(tool: string, args: Record<string, unknown>, print = true, soft = false): Promise<{ text?: string; data?: any; error?: string }> {
  const env = process.env;
  const node = env.TL_NODE_ID && env.TL_TOKEN_FILE;
  const conflict = node && daemonConflict(env);
  if (conflict) return fail(conflict);
  let token: string;
  try { token = node ? readFileSync(env.TL_TOKEN_FILE!, 'utf8').trim() : adminToken(); }
  catch (e) { return fail(`cannot read token (is the daemon running?): ${(e as Error).message}`); }
  const endpoint = env.TL_ENDPOINT ?? `http://127.0.0.1:${daemonPort()}`;
  const res = await fetch(`${endpoint}/api/${tool}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': node ? env.TL_NODE_ID! : 'human', 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).catch((e: Error) => fail(`cannot reach daemon at ${endpoint}: ${e.message}`));
  if (res.status === 401) return fail('unauthorized: bad token, or the node no longer exists');
  const body = (await res.json().catch(() => ({}))) as { text?: string; data?: any; error?: string };
  if (!res.ok) return soft ? { error: body.error ?? `HTTP ${res.status}` } : fail(body.error ?? `HTTP ${res.status}`);
  if (print) console.log(body.text ?? JSON.stringify(body.data, null, 2));
  return body;
}

const APP = join(dirname(dirname(import.meta.dirname)), 'src-tauri/target/release/bundle/macos/Tiller.app');
// Cold start: the app reads --node. Already running: `open` only activates it, so callers also post `select`.
const openApp = (port: number, node?: string) =>
  spawnSync('open', ['--env', `TL_HOME=${home}`, '--env', `TL_PORT=${port}`, '-a', APP, ...(node ? ['--args', '--node', node] : [])]); // same daemon as this CLI

const argv = process.argv.slice(2);
const [cmd, ...rest] = /^[-./~]/.test(argv[0] ?? '') ? ['up', ...argv] : argv; // `tl --new` and `tl .` mean `tl up --new` and `tl up .`
const { values: f, positionals: pos } = parseArgs({
  args: rest, allowPositionals: true,
  options: {
    kind: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    'permission-mode': { type: 'string' }, role: { type: 'string' }, profile: { type: 'string' }, harness: { type: 'string' }, new: { type: 'boolean' }, 'request-id': { type: 'string' }, force: { type: 'boolean' }, lines: { type: 'string' },
    worktree: { type: 'boolean' }, 'no-app': { type: 'boolean' }, since: { type: 'string' }, follow: { type: 'boolean' }, 'keep-branch': { type: 'boolean' }, discard: { type: 'boolean' }, detached: { type: 'boolean' }, check: { type: 'boolean' }, close: { type: 'boolean' }, stat: { type: 'boolean' }, preset: { type: 'string' },
    after: { type: 'string', multiple: true }, 'after-success': { type: 'string', multiple: true }, now: { type: 'boolean' },
    fork: { type: 'string' }, root: { type: 'string' }, session: { type: 'string' }, base: { type: 'string' }, account: { type: 'string' },
  },
});
/** `--after a,b --after c` as [a, b, c]; undefined when absent. */
const ids = (v: string[] | undefined) => v?.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);

if (f.harness && !['claude', 'pi', 'codex'].includes(f.harness)) fail(`unknown harness: ${f.harness} (expected claude, pi or codex)`);
const isolation = () => (f.worktree ? 'worktree' : undefined);

/**
 * The session directory for `id` (a root, or any node of a tree; a non-root id also filters `tl log` to that node);
 * without one, this node's own ($TL_SESSION_DIR), else the orchestrator of the current directory.
 */
async function sessionTarget(id: string | undefined): Promise<{ dir: string; only?: string }> {
  if (!id && process.env.TL_SESSION_DIR) return { dir: process.env.TL_SESSION_DIR };
  if (id && existsSync(sessionDir(home, id))) return { dir: sessionDir(home, id) }; // a root, even a closed one
  const all = ((await call('list_nodes', {}, false)).data ?? []) as OrchestratorCandidate[];
  const cwd = realpathSync(process.cwd());
  const start = id ? all.find((n) => n.id === id) : pickOrchestrator(all, cwd) ?? pickOrchestrator(all, cwd, true);
  if (!start) return fail(id ? `no such node or session: ${id}` : `no orchestrator for ${cwd}; name a node id`);
  let root = start;
  for (let p = all.find((n) => n.id === root.parentId); p; p = all.find((n) => n.id === root.parentId)) root = p;
  return { dir: sessionDir(home, root.id), only: id && id !== root.id ? id : undefined };
}

switch (cmd) {
  case 'list': await call('list_nodes', {}); break;
  case 'usage': console.log((await call('list_nodes', {}, false)).text?.split('\n')[0]); break; // list_nodes' first line
  case 'ps':
    for (const n of (await call('list_nodes', {}, false)).data ?? []) {
      const spent = n.spentUsd !== undefined || n.spentIncomplete ? fmtUsd(n.spentUsd ?? 0, n.spentIncomplete) : '-';
      console.log([n.id, n.state, n.title, n.parentId ?? '-', n.age, spent].join('\t'));
    }
    break;
  case 'new': {
    if (!pos[0]) fail(usage());
    const harness: Harness | undefined = f.harness === 'claude' ? undefined : f.harness as Harness | undefined;
    const { data } = await call('spawn', { kind: harness ? 'agent' : 'claude', ...(harness ? { harness } : {}), title: pos.join(' '), cwd: resolve(f.cwd ?? process.cwd()), prompt: f.prompt, model: f.model, effort: f.effort, role: f.role, profile: f.profile, isolation: isolation(), base: f.base, preset: f.preset, account: f.account }, false);
    console.log(`started ${pos.join(' ')} (${data.nodeId})`);
    await call('select', { nodeId: data.nodeId }, false);
    if (existsSync(APP)) openApp(daemonPort(), data.nodeId);
    break;
  }
  case 'prompts':
    for (const r of ['orchestrator', 'worker'] as const) {
      const { path, override } = promptPath(home, realpathSync(process.cwd()), r);
      console.log(`${r}: ${path ?? 'built-in'}${override ? ' (repo override)' : ''}`);
    }
    break;
  case 'presets':
    for (const p of listPresets(realpathSync(resolve(f.cwd ?? process.cwd())), home)) {
      const fields = 'error' in p ? `error: ${p.error}` : Object.entries({ model: p.model, effort: p.effort, permissionMode: p.permissionMode, isolation: p.isolation, role: p.role, profile: p.profile, tools: p.tools?.join(','), disallowedTools: p.disallowedTools?.join(','), maxTurns: p.maxTurns })
        .flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`])).join(' ');
      console.log([p.name, p.source, fields].join('\t'));
    }
    break;
  case 'trust':
  case 'untrust': {
    if (process.env.TL_NODE_ID) fail('trust is a human-only operation; run it outside a Tiller node');
    const dir = realpathSync(resolve(f.cwd ?? process.cwd()));
    setProjectTrust(home, dir, cmd === 'trust');
    console.log(`${cmd === 'trust' ? 'trusted' : 'untrusted'} ${dir} for Tiller repo commands`);
    if (cmd === 'untrust') console.log('Legacy Claude trust, if present, still applies.');
    break;
  }
  case 'config':
    for (const [k, { value, source }] of Object.entries(effectiveProfileEntries(configEntries(realpathSync(resolve(f.cwd ?? process.cwd())), home)))) {
      const unset = k.startsWith('roles.') ? '(claude default)' : k === 'worktrees.include' ? '(.worktreeinclude)' : '(none)';
      console.log(`${k}: ${value === undefined ? unset : Array.isArray(value) ? JSON.stringify(value) : value}  [${source}]`);
    }
    break;
  case 'gate': {
    const dir = realpathSync(resolve(f.cwd ?? process.cwd()));
    // The config the daemon reads for a node here: the main checkout's for one of its worktrees, else this directory's.
    const main = await mainCheckout(dir).catch(() => dir);
    const gate = gateFor(dir.startsWith(join(main, WORKTREES_DIR)) ? main : dir, home) ?? fail(`no gate.command configured for ${dir}, or Claude does not trust it`);
    // The daemon's runner, with the output going to the terminal instead of gate.log.
    const err = await runCommands([gate.command], { cwd: dir, env: buildChildEnv({ PATH: await loginShellPath() }), log: '/dev/stdout', timeout: gate.timeoutMinutes * 60_000 })
      .then(() => undefined, (e: Error) => e);
    console.log(err ? `gate failed (${err.message})` : 'gate passed');
    process.exit(err ? 1 : 0);
    break;
  }
  case 'select':
    if (!pos[0]) fail(usage());
    await call('select', { nodeId: pos[0] }, false);
    if (existsSync(APP)) openApp(daemonPort(), pos[0]!);
    break;
  case 'mute':
  case 'unmute':
    await call('mute', { nodeId: pos[0] ?? fail(usage()), muted: cmd === 'mute' });
    break;
  case 'dnd': {
    const dur = pos[0]?.match(/^(\d+)(m|h)$/);
    if (pos[0] && pos[0] !== 'on' && pos[0] !== 'off' && !dur) fail(usage());
    await call('dnd', pos[0] ? { on: pos[0] !== 'off', ...(dur ? { minutes: Number(dur[1]) * (dur[2] === 'h' ? 60 : 1) } : {}) } : {});
    break;
  }
  case 'resume':
    if (!pos[0]) fail(usage());
    await call('resume', { nodeId: pos[0] });
    break;
  case 'restart':
    if (!pos[0]) fail(usage());
    await call('restart', { nodeId: pos[0], prompt: f.prompt });
    break;
  case 'prune': {
    const { data } = await call('prune', {}, false);
    console.log(`removed ${data.removed.length} exited node${data.removed.length === 1 ? '' : 's'}`);
    break;
  }
  case 'spawn': {
    // Each spawn field from its kebab-case flag; isolation, cwd and the id lists from tl's own spellings.
    const flag = (k: string) => (f as Record<string, unknown>)[k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)];
    const args = Object.fromEntries([...Object.keys(SPAWN_FIELDS), 'permissionMode', 'requestId'].map((k) => [k, flag(k)]));
    const kind = spawnKind(f.kind as NodeKind | undefined, f.harness as Harness | undefined);
    await call('spawn', { ...args, kind, cwd: f.cwd ?? (f.fork ? undefined : process.cwd()), isolation: isolation(), after: ids(f.after), afterSuccess: ids(f['after-success']) });
    break;
  }
  case 'diff':
    if (!pos[0]) fail(usage());
    await call('diff', { nodeId: pos[0], stat: f.stat });
    break;
  case 'send':
    if (pos.length < 2) fail(usage());
    await call('send', { nodeId: pos[0], text: pos.slice(1).join(' '), mode: f.now ? 'now' : undefined });
    break;
  case 'withdraw':
    if (!pos[0]) fail(usage());
    await call('withdraw', { messageId: pos[0] });
    break;
  case 'read':
    if (!pos[0]) fail(usage());
    await call('read', { nodeId: pos[0], what: pos[1] ?? 'summary', lines: f.lines ? Number(f.lines) : undefined });
    break;
  case 'history':
    await call('history', { rootId: f.root, query: pos.join(' ') || undefined });
    break;
  case 'transcript':
    if (!pos[0]) fail(usage());
    await call('transcript', { nodeId: pos[0], sessionId: f.session });
    break;
  case 'followup':
    if (!pos[0] || !f.prompt) fail(usage());
    await call('followup', { nodeId: pos[0], prompt: f.prompt, title: f.title });
    break;
  case 'close':
  case 'kill':
    if (!pos.length) fail(usage());
    if (f['keep-branch'] && f.discard) fail('--keep-branch and --discard exclude each other');
    await call('close', { nodeIds: pos, force: f.force, worktree: f['keep-branch'] ? 'keep' : f.discard ? 'discard' : undefined });
    break;
  case 'merge': {
    if (!pos[0]) fail(usage());
    const { data } = await call('merge', { nodeId: pos[0] });
    if (!data?.ok) process.exit(1); // conflicts: printed above
    if (f.close) await call('close', { nodeIds: [pos[0]] });
    break;
  }
  case 'worktrees':
    if (pos[0] && pos[0] !== 'clean') fail(usage());
    await call('worktrees', { cwd: realpathSync(resolve(f.cwd ?? process.cwd())), clean: pos[0] ? (f.force ? 'force' : 'safe') : undefined });
    break;
  case undefined:
  case 'up':
  case 'app': {
    if (pos.length > 1) fail(usage());
    let cwd: string | undefined;
    try { cwd = upDir(pos[0], !!(f.new || f.title || f.prompt || f.harness), process.cwd()); } catch (e) { fail((e as Error).message); }
    const port = daemonPort();
    if (!(await findDaemon(port))) await startDaemon(home, port).catch((e: Error) => fail(e.message));
    if (!cwd) {
      if (existsSync(APP)) { openApp(port); break; }
      console.log('app not built: run npm run app:build');
      spawnSync('open', [`http://127.0.0.1:${port}/?k=${adminToken()}`]);
      break;
    }
    const harness: Harness = (f.harness as Harness | undefined) ?? 'claude';
    const all = f.new ? [] : (((await call('list_nodes', {}, false)).data ?? []) as any[]);
    const existing = pickOrchestrator(all, cwd, false, harness);
    const dead = existing ? undefined : pickOrchestrator(all, cwd, true, harness);
    let id: string | undefined;
    if (existing) { console.log(`reattaching to ${existing.title} (${existing.id})`); id = existing.id; }
    else if (dead) {
      console.log(`resuming ${dead.title} (${dead.id})`);
      const r = await call('resume', { nodeId: dead.id }, false, true);
      if (r.error) console.log(`cannot resume (${r.error}); starting a new orchestrator`);
      else id = dead.id;
    }
    if (!id) {
      const title = f.title ?? basename(cwd);
      id = (await call('spawn', { kind: harness !== 'claude' ? 'agent' : 'claude', ...(harness !== 'claude' ? { harness } : {}), title, cwd, prompt: f.prompt }, false)).data.nodeId as string;
      console.log(`started ${title} (${id})`);
    }
    const target = id;
    if (existsSync(APP)) {
      openApp(port, target);
      await call('select', { nodeId: target }, false);
    } else {
      console.log('app not built: run npm run app:build');
      spawnSync('open', [`http://127.0.0.1:${port}/?k=${adminToken()}&node=${target}`]);
    }
    break;
  }
  case 'url':
    // The admin token stays out of the daemon log and out of agents' terminals; the human asks for it here.
    if (process.env.TL_NODE_ID) fail('tl url: refusing inside a node, since it prints the admin token');
    console.log(`http://127.0.0.1:${daemonPort()}/?k=${adminToken()}`);
    break;
  case 'status': {
    const h = await findDaemon(daemonPort());
    if (!h) { console.log('no daemon'); break; }
    const n = ((await call('list_nodes', {}, false)).data ?? []).length;
    console.log(`daemon pid ${h.pid}, home ${h.home}, port ${daemonPort()}, ${n} node${n === 1 ? '' : 's'}`);
    break;
  }
  case 'stop':
    if (!(await findDaemon(daemonPort()))) { console.log('no daemon'); break; }
    await call('shutdown', {}, false);
    console.log('daemon stopped');
    break;
  case 'update': {
    if (process.env.TL_NODE_ID) fail('updates are human-only; run outside a Tiller node');
    if (f.detached) {
      const expected = JSON.parse(readFileSync(0, 'utf8')) as UpdateStatus;
      const say = (s: string) => appendFileSync(join(home, UPDATE_LOG), `${new Date().toISOString()} tl update: ${s}\n`);
      const restart = (sha: string) => restartDaemon(home, daemonPort(), sha, say, { reason: `update to ${expected.target?.tag}`, now: f.now });
      await applyUpdate({ repo: REPO, log: join(home, UPDATE_LOG), expected, restart })
        .catch((e: Error) => fail(`tl update: ${e.message}; see ${join(home, UPDATE_LOG)}`));
      break;
    }
    const result = await call('update', {}, true);
    if (f.check) break;
    const s = result.data;
    if (!s?.eligible || !s.target || (s.sha === s.target.sha && (!s.runtimeSha || s.runtimeSha === s.target.sha))) break;
    await call('update', { apply: true, tag: s.target.tag, sha: s.target.sha, now: f.now });
    break;
  }
  case 'reload': {
    if (updateLocked(REPO)) fail('an update holds this checkout; inspect update.log and wait for it before reloading');
    const self = process.env.TL_NODE_ID; // its own turn waits on this command, so the drain does not wait for it
    process.env = humanEnv(process.env); // run from a node's terminal, still restart as the human
    const port = daemonPort();
    if (!f.detached) {
      const running = await findDaemon(port);
      if (!running) { await startDaemon(home, port).catch((e: Error) => fail(e.message)); console.log('no daemon was running; started it'); break; }
      if (running.home !== home) fail(`daemon pid ${running.pid} uses home ${running.home}, not ${home}; stop it with kill ${running.pid} and run tl reload again`);
      let cancel: (() => void) | undefined;
      if (!f.now) {
        const abort = new AbortController();
        // Stop polling first, then cancel: a poll still in flight would otherwise hold again after the cancel.
        const draining = drainDaemon(home, port, { reason: 'tl reload', exclude: self, say: (s) => console.log(`tl reload: ${s}`), signal: abort.signal });
        cancel = () => {
          abort.abort();
          void draining.catch(() => {}).then(() => cancelDrain(home, port)).catch(() => {}).finally(() => {
            console.log('tl reload: cancelled; the daemon delivers the messages and spawns it held');
            process.exit(130);
          });
        };
        process.once('SIGINT', cancel);
        await draining.catch((e: Error) => abort.signal.aborted ? new Promise(() => {}) : fail(`tl reload: ${e.message}`)); // a cancel exits above
      }
      console.log(`reloading daemon; the new one resumes the nodes that were live; log in ${spawnReload(home, port)}`);
      if (cancel) process.off('SIGINT', cancel); // only once the restart is handed off
      break;
    }
    // The detached helper revalidates daemon and launchd ownership before restarting. Any wait for agents happened in
    // the foreground; the hold it set lasts until this restart.
    await restartDaemon(home, port, undefined, (s) => console.log(`tl reload: ${s}`), { reason: 'tl reload', now: true })
      .catch((e: Error) => fail(`tl reload: ${e.message}`));
    break;
  }
  case 'autostart': {
    const st = agentStatus();
    if (pos[0] === 'status') {
      console.log(`${LABEL}: ${st.installed ? `installed (${plistPath()})` : 'not installed'}, ${st.loaded ? `loaded${st.pid ? `, daemon pid ${st.pid}` : ', not running'}` : 'not loaded'}`);
    } else if (pos[0] === 'on') {
      if (st.loaded) { console.log(`autostart is already on; run tl autostart off, then on, to rewrite ${plistPath()}`); break; }
      const running = await findDaemon(daemonPort());
      if (running && running.home !== home) fail(`daemon pid ${running.pid} uses home ${running.home}, not ${home}; stop it with kill ${running.pid} (its nodes resume on the next start) and run this again`);
      const env: Record<string, string> = { TL_HOME: home, PATH: await loginShellPath(), ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}) };
      if (process.env.TL_PORT) env.TL_PORT = process.env.TL_PORT;
      install({ label: LABEL, program: TLD, env, log: join(home, 'daemon.log') });
      console.log(`autostart on: ${plistPath()} loaded; the daemon starts at login and after a crash, not after tl stop`);
      // The agent's first launch finds the port busy and exits 0, so the running daemon stays as it is.
      if (running) console.log(`daemon pid ${running.pid} keeps running outside launchd; tl reload hands it to launchd`);
    } else if (pos[0] === 'off') {
      uninstall();
      console.log(`autostart off${st.pid ? `; stopped daemon pid ${st.pid} (its nodes resume on the next start)` : ''}`);
    } else fail(usage());
    break;
  }
  case 'sessions': {
    if (pos[0] === 'path') { console.log((await sessionTarget(pos[1])).dir); break; }
    if (pos[0] === 'clean') { await call('sessions_clean', {}); break; }
    if (pos[0]) fail(usage());
    const now = Date.now();
    for (const x of listSessions(home).sort((a, b) => b.newest - a.newest)) {
      const closed = x.closedAt ? `closed ${new Date(x.closedAt).toLocaleString('sv-SE').slice(0, 16)}` : 'open';
      console.log([x.rootId, (x.title ?? '?').slice(0, 30), fmtAge(now - (x.createdAt ?? x.newest)), `${(x.bytes / 1024).toFixed(1)} KB`, closed].join('\t'));
    }
    break;
  }
  case 'log': {
    const since = f.since ? parseSince(f.since) : 0;
    if (since === undefined) fail('--since takes a number and s, m, h or d, for example 2h');
    const { dir, only } = await sessionTarget(pos[0]);
    const show = (evs: SessionEvent[]) => { for (const e of evs) if (!only || e.id === only) console.log(formatEvent(e)); };
    const cutoff = since ? Date.now() - since : 0;
    if (!f.follow) { show(readEvents(dir, cutoff)); break; }
    let cursor: EventCursor | undefined;
    const tick = () => { const r = readNewEvents(dir, cursor, cutoff); cursor = r.cursor; show(r.events); };
    tick();
    setInterval(tick, 1000);
    break;
  }
  case 'doctor': {
    const r = spawnSync(join(dirname(dirname(import.meta.dirname)), 'bin/setup'), ['--check', ...rest], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  case 'help': console.log(usage()); break;
  default: fail(usage());
}
