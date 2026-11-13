// Manual end-to-end check of questions for the human with a real agent (costs a little API usage; Claude on haiku by default).
// Starts its own daemon on a temporary home and a free port, never the live one, and stops it by pid.
//   npx tsx spike/e2e-questions.ts [--harness claude|pi|codex]
// Optional: TL_E2E_HOME and TL_E2E_PORT to choose them (the home is then kept), TL_KEEP=1 to keep a temporary home.
// It inherits nothing named TL_*: inside a tiller node TL_HOME names the live home, and a second daemon on it would resume
// the live nodes. It refuses a home that resolves to ~/.tiller or to TL_HOME, and ports 7788 and 7790.
// An agent calls ask_human ("Which colour?", red or blue) and ends its turn. The script checks the question reaches a
// client and `tl questions`, restarts the daemon, checks the question survived, answers "blue" over the WebSocket, and
// checks the agent got the answer (it writes it to answer.txt) and that the event log tells the same story.
// Pi bills an OpenRouter account and Codex its own: run those only with the owner's say-so. Exits non-zero on failure.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, Question, ServerMessage } from '../src/shared/protocol.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const harness = process.argv.includes('--harness') ? process.argv[process.argv.indexOf('--harness') + 1] : 'claude';
if (!['claude', 'pi', 'codex'].includes(harness)) throw new Error(`unknown harness: ${harness}`);
const madeHome = !process.env.TL_E2E_HOME;
const HOME = process.env.TL_E2E_HOME ?? mkdtempSync(join(tmpdir(), 'tl-questions-'));
mkdirSync(HOME, { recursive: true });
// Compare real paths, so a symlink or a trailing slash cannot get past the check.
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
for (const live of [join(homedir(), '.tiller'), process.env.TL_HOME]) {
  if (live && real(live) === real(HOME)) throw new Error(`refusing to run on ${HOME}: that is a live tiller home`);
}
// No banners on the owner's screen from a test daemon (a question raises one at the needsYou level).
writeFileSync(join(HOME, 'config.json'), JSON.stringify({ notifications: { kinds: { needsYou: 'silent', done: 'silent', errored: 'silent', exited: 'silent', approval: 'silent' } } }));
const freePort =() => new Promise<number>((ok, fail) => {
  const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); });
});
const PORT = String(process.env.TL_E2E_PORT ?? await freePort());
if (['7788', '7790'].includes(PORT)) throw new Error(`refusing port ${PORT}: it belongs to a live daemon`);
// Nothing TL_* is inherited: inside a tiller node it names that node's daemon, and this script talks to its own.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TL_'))) as Record<string, string | undefined>;
Object.assign(env, { TL_HOME: HOME, TL_PORT: PORT, TL_DEBUG: '1' });

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const dlog = () => readFileSync(`${HOME}/daemon.log`, 'utf8');

const PROMPT = "Call the ask_human tool with the question 'Which colour?' and the choices red and blue, then end your turn. When the answer arrives, write the chosen colour to answer.txt.";
// The node runs in this checkout, which Claude already trusts (a fresh directory stops on a trust dialog). The answer's text
// names the file: its own session directory is where a node may write without a permission prompt.

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = probe(); if (v) return v; }
  log(`timeout waiting for ${what}`);
  return undefined;
}

async function startDaemon() {
  const out = openSync(`${HOME}/daemon.log`, 'a');
  appendFileSync(`${HOME}/daemon.log`, '\n=== daemon start ===\n');
  const p = spawn('node', ['--import', 'tsx', 'src/daemon/index.ts'], { cwd: REPO, env, stdio: ['ignore', out, out] });
  const exited = new Promise<number | null>((r) => p.on('exit', (c) => r(c)));
  await waitFor('daemon listening', 30_000, () => dlog().split('=== daemon start ===').pop()!.includes('listening'));
  log(`daemon pid ${p.pid} on port ${PORT}, home ${HOME}`);
  return { p, exited };
}

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const nodes = new Map<string, NodeView>();
  const questions = new Map<string, Question>();
  let snapshot: Extract<ServerMessage, { t: 'snapshot' }> | undefined;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    if (m.t === 'snapshot') { snapshot = m; for (const n of m.nodes) nodes.set(n.id, n); for (const q of m.questions ?? []) questions.set(q.id, q); }
    else if (m.t === 'node') nodes.set(m.node.id, m.node);
    else if (m.t === 'question') { questions.set(m.question.id, m.question); log(`question ${m.question.id} ${m.question.state}${m.question.delivery ? ` delivery=${m.question.delivery.state}` : ''}`); }
    else if (m.t === 'error') log(`ws error ${m.message}`);
  });
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  send({ t: 'auth', token: readFileSync(`${HOME}/admin-token`, 'utf8').trim() });
  await waitFor('snapshot', 10_000, () => snapshot);
  return { ws, nodes, questions, send, snapshot: () => snapshot };
}

async function api(tool: string, body: object): Promise<any> {
  const token = readFileSync(`${HOME}/admin-token`, 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

const tl = (...args: string[]) => execFileSync(join(REPO, 'bin/tl'), args, { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
const events = (rootId: string): Record<string, any>[] => {
  const file = join(HOME, 'sessions', rootId, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

let d: Awaited<ReturnType<typeof startDaemon>> | undefined;

async function main(): Promise<void> {
  d = await startDaemon();
  let c = await connect();

  // Haiku keeps this cheap.
  const spawned = await api('spawn', { kind: harness === 'claude' ? 'claude' : 'agent', ...(harness !== 'claude' ? { harness } : { model: 'haiku' }), title: 'asker', cwd: REPO, prompt: PROMPT });
  const id: string = spawned.data?.nodeId ?? '';
  check(!!id, `spawned the asking node ${id || JSON.stringify(spawned)}`);
  if (!id) throw new Error('spawn failed');

  const asked = await waitFor('an open question', 180_000, () => [...c.questions.values()].find((q) => q.state === 'open'));
  check(!!asked, `a question reached the client: ${JSON.stringify(asked && { id: asked.id, question: asked.question, choices: asked.choices, nodeId: asked.nodeId })}`);
  if (!asked) return;
  check(asked.nodeId === id && asked.askedBy.id === id, 'the question is owned by, and asked by, the node');
  check(JSON.stringify(asked.choices) === JSON.stringify(['red', 'blue']), 'the choices are red and blue');
  const listed = tl('questions');
  log(`tl questions:\n${listed}`);
  check(listed.includes(asked.id) && listed.includes('Which colour?') && listed.includes('1) red   2) blue'), 'tl questions lists it with numbered choices');

  // The question must outlive the daemon, and the answer must still find the node afterwards.
  d.p.kill('SIGTERM');
  log(`daemon exited with ${await d.exited}`);
  c.ws.close();
  await sleep(1000);
  check(existsSync(join(HOME, 'questions.json')) && readFileSync(join(HOME, 'questions.json'), 'utf8').includes(asked.id), 'questions.json holds the question after the daemon stopped');
  d = await startDaemon();
  c = await connect();
  check(c.snapshot()?.questions?.some((q) => q.id === asked.id && q.state === 'open') === true, 'the snapshot after the restart still carries the open question');
  await waitFor('the node running again', 120_000, () => c.nodes.has(id) && !c.nodes.get(id)!.status.exited); // a running node has no `exited` flag at all

  const answerFile = join(HOME, 'sessions', asked.rootId, 'answer.txt');
  c.send({ t: 'question', id: asked.id, action: 'answer', choice: 'blue', text: `Write the colour to ${answerFile}` });
  const done = await waitFor('the answer delivered', 180_000, () => { const q = c.questions.get(asked.id); return q?.state === 'answered' && q.delivery?.state === 'delivered' && q; });
  check(!!done, `the question is answered with delivery ${JSON.stringify(c.questions.get(asked.id)?.delivery)}`);
  const wrote = await waitFor('answer.txt', 180_000, () => existsSync(answerFile) && readFileSync(answerFile, 'utf8').trim());
  check(/blue/i.test(wrote || ''), `answer.txt contains the answer: ${JSON.stringify(wrote)}`);

  const log2 = events(asked.rootId);
  const sendEvent = log2.find((e) => e.type === 'send' && e.label === `human (answer to ${asked.id})`);
  const settled = sendEvent && (sendEvent.outcome === 'delivered' || log2.some((e) => e.type === 'settle' && e.messageId === sendEvent.messageId && e.outcome === 'delivered'));
  check(log2.some((e) => e.type === 'ask' && e.questionId === asked.id), 'events.jsonl has the ask');
  check(log2.some((e) => e.type === 'ask_answer' && e.questionId === asked.id && e.choice === 'blue'), 'events.jsonl has the ask_answer');
  check(!!settled, `events.jsonl has a send labelled "human (answer to ${asked.id})" that settled delivered: ${JSON.stringify(sendEvent)}`);

  c.send({ t: 'close', id, force: true });
  await sleep(1000);
  c.ws.close();
}

main().catch((e) => { failures++; log(`ERROR ${e}`); }).finally(async () => {
  if (d && d.p.exitCode === null) { d.p.kill('SIGTERM'); await d.exited; } // by pid, whatever happened
  log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
  if (madeHome && !process.env.TL_KEEP) rmSync(HOME, { recursive: true, force: true });
  else log(`kept ${HOME}`);
  process.exit(failures ? 1 : 0);
});
