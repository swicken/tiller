// Records the demo: a temp daemon running real Claude agents on the sample repo, the browser UI in headless Chromium
// driven through the demo beats. One long video is recorded and cut into per-beat clips with ffmpeg.
//   node run.mjs [--out DIR]   (clips go to $DEMO_DIR/clips by default; DEMO_DIR defaults to ~/.tiller-demo)
// Each run uses a fresh scratch directory and a freshly made sample repo. The daemon is stopped by pid at the end.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { makeSampleRepo } from './make-sample-repo.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const { values: opts } = parseArgs({ options: { out: { type: 'string' } } });
const DEMO = process.env.DEMO_DIR ?? join(homedir(), '.tiller-demo');
const OUT = resolve(opts.out ?? join(DEMO, 'clips'));
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tiller-demo-')));
const TL_HOME = join(SCRATCH, 'home');
// A stable path, so Claude's folder trust for it (recorded on the first run) carries over to later runs.
const SAMPLE = resolve(DEMO, 'sample-repo');

const TASK = 'Add a --json flag to the CLI, write its tests, and document it in the README. Use one worker per part, in '
  + 'worktrees. Spawn one reviewer node with preset reviewer to check the branches before merging, then merge.';
const COMMENT = 'Looks good. Keep the JSON on one line so it pipes cleanly into jq.';

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment for the temp daemon and bin/tl: no link to the live daemon or to the Claude session running this. */
function cleanEnv(port) {
  const env = { ...process.env, TL_HOME, TL_PORT: String(port) };
  for (const k of Object.keys(env)) {
    if ((k.startsWith('TL_') && k !== 'TL_HOME' && k !== 'TL_PORT') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') delete env[k];
  }
  return env;
}

const freePort = () => new Promise((ok, fail) => {
  const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

// ---- the daemon and a live view of its nodes ----

const nodes = new Map(); // id -> NodeView, live nodes only
const spend = new Map(); // id -> last spentUsd seen, closed nodes included
const removedAt = new Map(); // id -> ms
let ws;

function watch(port, token) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
  ws.on('error', (e) => log(`ws error: ${e.message}`));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const seen = (n) => { nodes.set(n.id, n); if (n.spentUsd !== undefined) spend.set(n.id, n.spentUsd); };
    if (m.t === 'snapshot') m.nodes.forEach(seen);
    else if (m.t === 'node') {
      const before = nodes.get(m.node.id);
      seen(m.node);
      const s = m.node.status;
      if (!before || before.status.state !== s.state || !before.outcome !== !m.node.outcome) {
        log(`node ${m.node.id} "${m.node.title}" ${s.state}${m.node.outcome ? ` outcome=${m.node.outcome.outcome}` : ''}${s.activity ? ` (${s.activity})` : ''}`);
      }
    } else if (m.t === 'removed') { log(`removed ${m.id} "${nodes.get(m.id)?.title}"`); nodes.delete(m.id); removedAt.set(m.id, Date.now()); }
  });
  return new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
}

async function until(what, ms, probe) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const v = probe();
    if (v) return v;
  }
  log(`timed out after ${ms / 1000}s waiting for ${what}`);
  return undefined;
}

const children = (id) => [...nodes.values()].filter((n) => n.parentId === id);
const isReviewer = (n) => n.preset === 'reviewer' || /review/i.test(n.title);
const finished = (n) => n.status.state === 'done' || n.status.exited;

// ---- main ----

const port = await freePort();
if (port === 7788) throw new Error('refusing the live daemon port');
const env = cleanEnv(port);
mkdirSync(TL_HOME, { recursive: true });
mkdirSync(OUT, { recursive: true });
// This run's outputs replace the last run's; anything else in OUT (a run.log, say) is left alone.
for (const f of readdirSync(OUT)) if (/\.(mp4|png)$/.test(f) || ['full.webm', 'clips.json', 'tl-list.txt'].includes(f)) rmSync(join(OUT, f));
makeSampleRepo(SAMPLE);
log(`scratch ${SCRATCH}, sample repo ${SAMPLE}, port ${port}`);

const daemonLog = createWriteStream(join(SCRATCH, 'daemon.log'));
// node with the tsx loader rather than the tsx wrapper, so daemon.pid is the daemon itself.
const daemon = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src/daemon/index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.pipe(daemonLog); daemon.stderr.pipe(daemonLog);
log(`daemon pid ${daemon.pid}, log ${join(SCRATCH, 'daemon.log')}`);
// Ctrl-C, a closed terminal, a kill or a crash skip the finally below, so stop the daemon by pid here too.
process.on('exit', () => { if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM'); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { log(`${sig}: stopping daemon pid ${daemon.pid}`); process.exit(130); });
}

let token;
/** POST /api/<tool> as the human. */
async function api(tool, body) {
  const r = await fetch(`http://127.0.0.1:${port}/api/${tool}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': 'human', 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`${tool}: HTTP ${r.status}`);
  return r.json();
}

const marks = []; // { beat, start, end, notes } in ms on the video's clock
const stills = [];
const failures = [];
let browser, ctx, page;
try {
  const tokenFile = join(TL_HOME, 'admin-token');
  if (!(await until('daemon admin token', 30_000, () => existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim()))) throw new Error('daemon did not start');
  token = readFileSync(tokenFile, 'utf8').trim();
  await watch(port, token);

  browser = await chromium.launch();
  ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark',
    recordVideo: { dir: SCRATCH, size: { width: 1920, height: 1080 } },
  });
  // recordVideo captures CSS pixels and never upscales, so a deviceScaleFactor does not reach the video. Zooming the
  // page instead lays the UI out 1.5x larger inside the full 1920x1080 frame, at native pixels.
  await ctx.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.zoom = '1.5'; }); });
  page = await ctx.newPage();
  const v0 = Date.now(); // the video's clock starts with the page
  const vt = (ms = Date.now()) => Math.max(0, ms - v0);
  const still = async (name) => { const path = join(OUT, `${name}.png`); await page.screenshot({ path }); stills.push(`${name}.png`); log(`still ${name}.png`); };
  const mark = (beat, start, notes) => { const m = { beat, start: vt(start), end: vt(), notes }; marks.push(m); log(`beat ${beat} ${m.start}-${m.end} ms`); };
  const row = (id) => page.locator(`.row[data-id="${id}"]`);
  const select = async (id) => { await row(id).click(); await sleep(400); };
  const panelOpen = async (on) => {
    const b = page.getByRole('button', { name: 'Toggle last message panel' });
    if ((await b.getAttribute('aria-pressed')) !== String(on)) await b.click();
  };
  /** Runs one beat after the tree exists; a failure is logged with a still and the run goes on to the next beat. */
  const beat = async (name, fn) => {
    try { await fn(); } catch (e) {
      failures.push(`${name}: ${e.message.split('\n')[0]}`);
      log(`beat ${name} failed: ${e.message}`);
      await still(`${name}-error`).catch(() => {});
    }
  };

  await page.goto(`http://127.0.0.1:${port}/?k=${token}`);
  await page.getByText('No sessions yet.').first().waitFor();
  await sleep(1500);

  // 10: the task goes to one agent through the New session dialog.
  let start = Date.now();
  await page.locator('.empty').getByRole('button', { name: 'New session' }).click();
  const form = page.locator('form.form');
  await form.getByLabel('Title').pressSequentially('add --json', { delay: 60 });
  await form.getByLabel('Working directory').fill(SAMPLE);
  await form.getByLabel('Initial prompt').pressSequentially(TASK, { delay: 12 });
  await sleep(800);
  await still('10-task-dialog');
  await form.getByRole('button', { name: 'Spawn' }).click();
  const orch = await until('orchestrator', 15_000, () => [...nodes.values()].find((n) => n.parentId === null)?.id);
  if (!orch) throw new Error('the orchestrator did not appear');
  // The dialog sends a role only when it differs from the default for the position (a root is an orchestrator), so
  // the record's role is absent and derived at launch; the model then comes from roles.orchestrator in the config.
  const o = nodes.get(orch);
  log(`spawned ${orch}: role ${o.role ?? '(derived: orchestrator)'}, model ${o.model ?? '(default)'}`);
  if ((o.role ?? 'orchestrator') !== 'orchestrator' || o.model !== 'sonnet') throw new Error(`spawned record is not an orchestrator on sonnet: role ${o.role}, model ${o.model}`);

  // Until Claude starts its first turn: dump the node's screen every 15 s, and if the folder-trust dialog is up
  // (it is not once the human has trusted the sample path), select "Yes, I trust this folder" and confirm. Enter on
  // the default "No, exit" would quit Claude, so Enter is sent only once Yes is selected: its line then starts with
  // the selection pointer instead of only spaces.
  let notes10 = '';
  let dumpAt = 0;
  for (const end = Date.now() + 180_000; nodes.get(orch)?.status.state !== 'working'; await sleep(1000)) {
    if (Date.now() > end) throw new Error('the orchestrator did not start working within 180 s');
    // The whole screen: the dialog draws at the top, and the UI makes the terminal taller than a short tail.
    const screen = (await api('read', { nodeId: orch, what: 'terminal', lines: 300 }).catch(() => ({}))).text ?? '';
    if (Date.now() - dumpAt >= 15_000) {
      dumpAt = Date.now();
      log(`orchestrator state ${nodes.get(orch)?.status.state}; screen:\n${screen.trim()}`);
      await still(`startup-${Math.round((Date.now() - start) / 1000)}s`);
    }
    if (screen.includes('Yes, I trust this folder')) {
      if (!notes10) log('answering the folder-trust dialog');
      notes10 = 'Includes Claude\'s folder-trust dialog being accepted; trim it. ';
      await page.locator('.term.show').click();
      await page.keyboard.press(/^\s*[^\s\w.]+\s+(\d+\.\s+)?Yes, I trust this folder/m.test(screen) ? 'Enter' : 'ArrowDown');
    }
  }
  await sleep(6000);
  mark('10-task', start, `${notes10}New session dialog typed and spawned; the orchestrator starts in its terminal.`);

  // 20: the tree grows.
  const first = await until('first worker', 300_000, () => children(orch).length > 0);
  if (!first) throw new Error('the orchestrator spawned no workers');
  start = Date.now() - 3000;
  await until('three workers', 120_000, () => children(orch).filter((n) => !isReviewer(n)).length >= 3);
  await sleep(8000);
  await still('20-tree');
  const workers = children(orch).filter((n) => !isReviewer(n)).map((n) => n.id);
  mark('20-tree', start, `${workers.length} workers spawned: ${workers.map((id) => `${nodes.get(id)?.title} (${nodes.get(id)?.worktree ? 'worktree' : 'no worktree'})`).join(', ')}.`);

  // 30: a worker finishes and its outcome shows.
  const doneId = await until('a worker outcome', 900_000, () => workers.find((id) => nodes.get(id)?.outcome));
  let diffId;
  if (doneId) await beat('30-watch', async () => {
    start = Date.now();
    await select(doneId);
    await panelOpen(true);
    await sleep(8000);
    await still('30-outcome');
    mark('30-watch', start, `"${nodes.get(doneId)?.title}" reported ${nodes.get(doneId)?.outcome?.outcome}; last-message panel shows its outcome.`);
    diffId = doneId;
  });

  // 40: review its diff and send a line comment back.
  diffId = [diffId, ...workers].find((id) => {
    const n = id && nodes.get(id);
    return n?.worktree && n.status.git && n.status.git.ahead + n.status.git.dirty > 0;
  });
  if (diffId) await beat('40-diff', async () => {
    start = Date.now();
    await select(diffId);
    await panelOpen(false);
    await page.locator('.seg.tabs').getByRole('button', { name: 'Diff' }).click();
    await page.locator('.diffbody').waitFor({ timeout: 20_000 });
    await sleep(2500);
    const src = page.locator('nav.files .file', { hasText: 'src/cli.js' });
    if (await src.count()) { await src.first().click(); await sleep(1500); }
    const added = page.locator((await page.locator('.dl.add').count()) ? '.dl.add' : '.dl.ctx');
    await added.nth(Math.min(2, (await added.count()) - 1)).click();
    await page.getByLabel('Comment').pressSequentially(COMMENT, { delay: 35 });
    await sleep(600);
    await page.getByRole('button', { name: 'Add comment' }).click();
    await sleep(1500);
    await still('40-diff-comment');
    await page.getByRole('button', { name: /^Send \d+ comment/ }).click();
    await sleep(4000);
    mark('40-diff', start, `Diff of "${nodes.get(diffId)?.title}", one line comment added and sent.`);
  }); else log('no worker with changes to diff');

  // 50: the reviewer.
  const findReviewer = () => [...nodes.values()].find(isReviewer)?.id;
  let reviewer = await until('a reviewer node', 300_000, findReviewer);
  if (!reviewer) {
    log('nudging the orchestrator to spawn the reviewer');
    await api('send', { nodeId: orch, text: 'Before merging, spawn one reviewer node with preset reviewer to check the workers\' branches, as the task asks.' })
      .catch((e) => log(`nudge failed: ${e.message}`));
    reviewer = await until('a reviewer node after the nudge', 300_000, findReviewer);
  }
  if (reviewer) await beat('50-review', async () => {
    start = Date.now();
    await page.locator('.seg.tabs').getByRole('button', { name: 'Terminal' }).click().catch(() => {});
    await select(reviewer);
    await sleep(8000);
    await still('50-review');
    mark('50-review', start, `Reviewer "${nodes.get(reviewer)?.title}" (preset ${nodes.get(reviewer)?.preset ?? 'none'}) at work.`);
  });

  // 55: merges, and the tree shrinks as workers close.
  await select(orch).catch(() => {});
  const firstClose = await until('a worker to close', 1_200_000, () => workers.find((id) => removedAt.has(id)));
  if (firstClose) {
    start = removedAt.get(firstClose) - 4000;
    await until('all workers closed', 300_000, () => workers.every((id) => removedAt.has(id)) && (!reviewer || !nodes.has(reviewer)));
    await sleep(4000);
    await still('55-merge');
    mark('55-merge', start, `Workers closed after merge: ${workers.filter((id) => removedAt.has(id)).length} of ${workers.length}.`);
  }

  // 60: history.
  await until('orchestrator turn to end', 600_000, () => finished(nodes.get(orch)) && children(orch).length === 0);
  await sleep(2000);
  await beat('60-history', async () => {
    start = Date.now();
    await page.getByRole('button', { name: 'History' }).click();
    await page.locator('.arch').first().waitFor({ timeout: 15_000 });
    await sleep(3000);
    await still('60-history-list');
    await page.locator('.arch', { has: page.locator('.branch') }).first().click();
    await sleep(3000);
    await still('60-history-node');
    await page.mouse.move(1100, 700);
    await page.mouse.wheel(0, 600);
    await sleep(3000);
    mark('60-history', start, 'History panel, then one closed worker with its brief, branch fate line and transcript.');
  });

  // The orchestrator's final state, for the end of the story.
  await beat('70-final', async () => {
    start = Date.now();
    const history = page.getByRole('button', { name: 'History' });
    if ((await history.getAttribute('aria-pressed')) === 'true') await history.click();
    await select(orch);
    await panelOpen(true);
    await sleep(5000);
    await still('70-final');
    mark('70-final', start, 'The orchestrator with its final message in the last-message panel.');
  });
} catch (e) {
  failures.push(`fatal: ${e.message.split('\n')[0]}`);
  log(`run stopped early: ${e.stack}`);
  process.exitCode = 1;
} finally {
  // Closing the context writes the video, so a broken run still yields the beats it reached.
  await ctx?.close().catch((e) => log(`closing the browser context: ${e.message}`));
  const video = await page?.video()?.path().catch(() => undefined);
  if (video && existsSync(video)) renameSync(video, join(OUT, 'full.webm'));
  await browser?.close();
  ws?.close();
  const tl = spawnSync(join(ROOT, 'bin/tl'), ['list'], { env, encoding: 'utf8' });
  writeFileSync(join(OUT, 'tl-list.txt'), tl.stdout + tl.stderr);
  daemon.kill('SIGTERM');
  await until('daemon exit', 15_000, () => daemon.exitCode !== null || daemon.signalCode !== null);
  log(`daemon stopped (${daemon.exitCode ?? daemon.signalCode})`);
}

// ---- cut the clips ----

const clips = [];
for (const m of marks) {
  const file = `${m.beat}.mp4`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(m.start / 1000), '-to', String(m.end / 1000), '-i', join(OUT, 'full.webm'),
    '-an', '-r', '30', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', join(OUT, file)], { encoding: 'utf8' });
  if (r.status !== 0) { log(`ffmpeg failed for ${file}: ${r.stderr}`); continue; }
  clips.push({ beat: m.beat, file, durationMs: m.end - m.start, startInFullMs: m.start, notes: m.notes });
}
const totalUsd = [...spend.values()].reduce((a, b) => a + b, 0);
writeFileSync(join(OUT, 'clips.json'), JSON.stringify({ clips, stills, failures, full: 'full.webm', totalUsd: Number(totalUsd.toFixed(2)), recordedAt: new Date(t0).toISOString() }, null, 2) + '\n');
log(`wrote ${clips.length} clips and clips.json to ${OUT}; agent spend $${totalUsd.toFixed(2)}`);
