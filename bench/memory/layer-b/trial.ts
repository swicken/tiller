// One Layer B trial (bench plan §3.1): seed the phase-1 history into a store (B0 checks the planted lesson reaches the
// digest), build the scripted R1 once per arm, fork the store into each arm's home, run every arm's phase-2 node at
// once in its own daemon, and record what each did. Phase 1 is seeded (canned episodes through the real derive and
// store); nothing of an arm's run reaches another arm.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Effort } from '../../../src/shared/protocol.js';
import { claudeProjectSlug } from '../../../src/daemon/claude-memory.js';
import { digestFor } from '../../../src/daemon/memory-digest.js';
import { MemoryStore } from '../../../src/daemon/memory-store.js';
import { readEvents, sessionDir } from '../../../src/daemon/sessions.js';
import { recordedSessions } from '../../../src/daemon/transcript.js';
import { Client } from '../lib/client.js';
import { prepareHome, startDaemon } from '../lib/daemon.js';
import { Case, type Fixture } from '../lib/fixture.js';
import { makeRepo } from '../lib/repo.js';
import { rng } from '../lib/stats.js';
import { GATE, type Files } from './repos.js';
import type { Scenario } from './scenarios.js';
import type { ArmRaw, Call, ToolCall, Trial } from './score.js';

export type Mode = ArmRaw['mode'];
export interface Arm { label: string; mode: Mode }

/** An arm's home config (§3.1 arms table): memory.enabled and memory.digest only. */
const CONFIG: Record<Mode, object> = {
  off: { memory: { enabled: false } },
  on: { memory: { enabled: true, digest: 'on' } },
  tools: { memory: { enabled: true, digest: 'off' } },
};

/** <arm dir>: repo/ (R1), home/ (its daemon's TL_HOME) and calls.jsonl, which the repo's scripts write. */
const armDir = (trialDir: string, a: Arm) => join(trialDir, a.label);

/** R1: the scenario's files committed and tagged origin-base, with the fake origin; returns memory's key for it. */
export function buildRepo(s: Scenario, dir: string): string {
  mkdirSync(dirname(dir), { recursive: true });
  return makeRepo(dir, s.repo, s.files(), 'origin-base');
}

/** Write files into a repo's working tree, uncommitted, as an agent's change would be. */
export function applyOverlay(repo: string, files: Files): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

export function writeHidden(s: Scenario, trialDir: string): void {
  for (const [name, text] of Object.entries(s.hidden ?? {})) {
    mkdirSync(join(trialDir, 'hidden'), { recursive: true });
    writeFileSync(join(trialDir, 'hidden', name), text);
  }
}

export interface Seeded {
  case: Case;
  /**
   * The ids of the B0 targets found in the digest (the on arm's injection must hold them; a b0Report scenario's are
   * recorded only), and the worker digest's ids and text for the brief (the off arm's shadow, H1).
   */
  targets: number[];
  missing: string[];
  shadow: number[];
  text: string;
}

/** Seed the scenario's phase-1 episodes into a temp store keyed to `repoKey`, then B0: its targets in the brief's digest. */
export function seed(s: Scenario, repoKey: string, now = Date.now()): Seeded {
  const fx: Fixture = { name: s.name, claim: s.claim, now: new Date(now).toISOString(), repos: { r: repoKey }, episodes: s.seed };
  const c = new Case(fx);
  c.replay();
  const { text, itemIds } = digestFor(c.store, c.scope('r'), { role: 'worker', brief: s.brief, now });
  const targets: number[] = [], missing: string[] = [];
  for (const m of s.targets) {
    const found = c.matching(m);
    if (found.length !== 1) missing.push(`${JSON.stringify(m)} matches ${found.length} items`);
    else if (!itemIds.includes(found[0].id)) missing.push(`m${found[0].id} (${found[0].text.slice(0, 80)}) is not in the digest`);
    else targets.push(found[0].id);
  }
  return { case: c, targets, missing, shadow: itemIds, text };
}

/** Run the gate command in a repo as the daemon would, returning its exit code and output. */
function runGate(repo: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('sh', ['-c', GATE], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export interface Preflight { items: number; digest: string; digestIds: number[]; checks: { ok: boolean; what: string }[] }

/**
 * The $0 preflight (B0 and the repo checks) in a temp dir laid out like a trial: B0's targets in the digest (or, for a
 * b0Report scenario, recorded), R1's gate as expected, the scripts logging to the arm's call log, the solved overlay
 * passing the gate and the trapped one failing it.
 */
export function preflight(s: Scenario): Preflight {
  const dir = mkdtempSync(join(tmpdir(), 'tl-bench-b0-'));
  const checks: Preflight['checks'] = [];
  const check = (ok: boolean, what: string) => checks.push({ ok, what });
  try {
    writeHidden(s, dir);
    const b0 = seed(s, buildRepo(s, join(dir, 'r1', 'repo')));
    const items = b0.case.rows().length;
    b0.case.close();
    const miss = b0.missing.join('; ');
    check(!miss || !!s.b0Report, `B0: targets in the digest${miss ? `: ${miss}${s.b0Report ? ' (recorded, not required)' : ''}` : ''}`);
    const r1 = runGate(join(dir, 'r1', 'repo'));
    check((r1.code === 0) === (s.r1Gate === 'pass'), `R1's gate ${r1.code === 0 ? 'passes' : 'fails'} (expected: ${s.r1Gate})`);
    const calls = existsSync(join(dir, 'r1', 'calls.jsonl')) ? readFileSync(join(dir, 'r1', 'calls.jsonl'), 'utf8') : '';
    check(/"cmd":"gate","arg":"","gate":"1"/.test(calls) && /"cmd":"gate-exit"/.test(calls), 'the gate logs its runs to the arm call log');
    const overlay = (name: string, files: Files) => {
      const repo = join(dir, name, 'repo');
      buildRepo(s, repo);
      applyOverlay(repo, files);
      return runGate(repo);
    };
    const solved = overlay('solved', s.solved);
    check(solved.code === 0, `the solved overlay passes the gate${solved.code ? `:\n${solved.out}` : ''}`);
    if (s.trapped) {
      const trapped = overlay('trapped', s.trapped);
      const line = trapped.out.split('\n').find((l) => /changelog check|AssertionError|acceptance:/.test(l))?.trim();
      check(trapped.code !== 0, `the trapped overlay fails the gate: ${line ?? trapped.out}`);
    }
    return { items, digest: b0.text, digestIds: b0.shadow, checks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lines = (raw: string) => raw.split('\n').flatMap((l) => {
  try { return l.trim() ? [JSON.parse(l) as Record<string, any>] : []; } catch { return []; }
});

/** A Claude transcript's tool calls (with the file or command they act on) and token usage, each message counted once. */
export function claudeTranscript(raw: string): { tools: ToolCall[]; tokens: ArmRaw['tokens'] } {
  const tools: ToolCall[] = [], seen = new Set<string>(), usage = new Map<string, Record<string, number>>();
  for (const e of lines(raw)) {
    if (e.type !== 'assistant' || !e.message) continue;
    const at = Date.parse(e.timestamp);
    for (const b of Array.isArray(e.message.content) ? e.message.content : []) {
      if (b?.type !== 'tool_use' || seen.has(b.id)) continue;
      seen.add(b.id);
      const input = (b.input ?? {}) as Record<string, unknown>;
      tools.push({
        at, name: String(b.name),
        ...(typeof input.file_path === 'string' ? { file: input.file_path } : {}),
        ...(typeof input.command === 'string' ? { command: input.command.slice(0, 500) } : {}),
      });
    }
    if (e.message.usage && e.message.id) usage.set(e.message.id, e.message.usage);
  }
  const sum = (k: string) => [...usage.values()].reduce((s, u) => s + (u[k] ?? 0), 0);
  return { tools, tokens: { input: sum('input_tokens'), output: sum('output_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens') } };
}

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).split('\n').filter(Boolean);

export interface TrialInput {
  s: Scenario;
  root: string;
  trialDir: string;
  trial: number;
  attempt: number;
  arms: Arm[];
  model: string;
  effort?: Effort;
  timeoutMs: number;
  /** A node that sits done without reporting this long ends as 'idle', a failure. */
  idleMs: number;
  log: (s: string) => void;
}

/** One paired trial. Throws only when the trial could not be set up (B0 failure included): nothing ran then. */
export async function runTrial(t: TrialInput): Promise<Trial> {
  const { s, trialDir } = t;
  writeHidden(s, trialDir);
  // R1 per arm: the same files at the same fixed date make the same commit, which the inputs hash records.
  const keys = t.arms.map((a) => buildRepo(s, join(armDir(trialDir, a), 'repo')));
  const heads = t.arms.map((a) => git(join(armDir(trialDir, a), 'repo'), 'rev-parse', 'HEAD')[0]);
  if (new Set(heads).size !== 1 || new Set(keys).size !== 1) throw new Error(`arms differ in R1: ${heads.join(', ')}`);
  const seeded = seed(s, keys[0]);
  try {
    if (seeded.missing.length && !s.b0Report) throw new Error(`B0 failed for ${s.id}: ${seeded.missing.join('; ')}`);
    for (const a of t.arms) {
      const home = join(armDir(trialDir, a), 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const db = new MemoryStore(home).accountFile(undefined);
      mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
      seeded.case.store.snapshot(undefined, db);
      prepareHome(home, t.root, CONFIG[a.mode]);
    }
  } finally {
    seeded.case.close();
  }
  const spawn = { kind: 'claude' as const, preset: 'bench', title: s.title, prompt: s.brief, isolation: 'none' as const, model: t.model, ...(t.effort ? { effort: t.effort } : {}) };
  const inputsHash = `sha256:${createHash('sha256').update(JSON.stringify({ r1: heads[0], spawn, scenario: s.name })).digest('hex')}`;
  const next = rng(Date.now() ^ (t.trial << 8));
  const order = [...t.arms].sort(() => next() - 0.5);
  const arms = await Promise.all(order.map((a, i) => runArm(t, a, spawn, i * 2_000)));
  return {
    trial: t.trial, attempt: t.attempt, startOrder: order.map((a) => a.label), inputsHash, targets: s.b0Report ? [] : seeded.targets, shadow: seeded.shadow,
    arms: t.arms.map((a) => arms[order.indexOf(a)]),
  };
}

/** One arm: its daemon, a terminal bench parent and the phase-2 node as its child (so it has the report_outcome contract). */
async function runArm(t: TrialInput, a: Arm, spawn: Record<string, unknown>, delayMs: number): Promise<ArmRaw> {
  const dir = armDir(t.trialDir, a), repo = join(dir, 'repo'), home = join(dir, 'home');
  const memoryDir = join(homedir(), '.claude', 'projects', claudeProjectSlug(repo), 'memory');
  const raw: ArmRaw = {
    label: a.label, mode: a.mode, end: 'error', endedAt: Date.now(), gates: [], calls: [], tools: [], injections: [], diff: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, autoMemory: existsSync(memoryDir),
  };
  await new Promise((r) => setTimeout(r, delayMs));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: Client | undefined, parentId: string | undefined;
  try {
    daemon = await startDaemon(home);
    client = await Client.connect(daemon);
    parentId = (await client.spawn({ kind: 'terminal', title: 'bench', cwd: repo })).id;
    const node = await client.spawn({ ...spawn, cwd: repo, parentId } as Parameters<Client['spawn']>[0]);
    raw.nodeId = node.id;
    const ended = await client.awaitOutcome(node.id, t.timeoutMs, t.idleMs);
    raw.end = ended.end;
    if (ended.detail) raw.detail = ended.detail;
    raw.endedAt = Date.now();
    const view = client.nodes.get(node.id) ?? node;
    Object.assign(raw, { outcome: view.outcome, createdAt: view.createdAt, spentUsd: view.spentUsd, errored: view.status.errored });
    for (const sess of recordedSessions(view)) {
      if (!existsSync(sess.transcriptPath)) continue;
      const tr = claudeTranscript(readFileSync(sess.transcriptPath, 'utf8'));
      raw.tools.push(...tr.tools);
      for (const k of Object.keys(raw.tokens) as (keyof ArmRaw['tokens'])[]) raw.tokens[k] += tr.tokens[k];
    }
    client.send({ t: 'close', id: node.id });
    client.send({ t: 'close', id: parentId, force: true });
    await client.waitFor(() => !client!.nodes.has(node.id) && !client!.nodes.has(parentId!), 15_000);
  } catch (err) {
    raw.end = 'error';
    raw.detail = (err as Error).message;
  } finally {
    client?.close();
    await daemon?.stop();
  }
  if (parentId && raw.nodeId) {
    raw.gates = readEvents(sessionDir(home, parentId)).filter((e) => e.type === 'gate' && e.id === raw.nodeId).map((e) => ({ ts: e.ts, ok: e.ok === true }));
    const store = new MemoryStore(home);
    try { raw.injections = store.injections(undefined, raw.nodeId); } catch { /* memory off: no file to read */ } finally { store.close(); }
  }
  const calls = join(dir, 'calls.jsonl');
  if (existsSync(calls)) raw.calls = lines(readFileSync(calls, 'utf8')) as Call[];
  try {
    raw.diff = [...new Set([...git(repo, 'diff', '--name-only', 'origin-base'), ...git(repo, 'ls-files', '--others', '--exclude-standard')])].sort();
  } catch { /* the repo is gone or broken: an empty diff */ }
  t.log(`${a.label}: ${raw.end}${raw.outcome ? ` ${raw.outcome.outcome}/${raw.outcome.gate ?? '-'}` : ''}, ${raw.gates.length} gate runs, ${raw.tools.length} tools, $${raw.spentUsd?.toFixed(3) ?? '?'}`);
  return raw;
}
