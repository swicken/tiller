// derive(): what memory records from one captured event, given the node's episodes since its previous outcome. Pure: no
// I/O and no clock, so tests and replays run the same code as captureMemory. Trust rules: plan D4 rules 3-5.
import type { ArchivedNode, Outcome } from '../shared/protocol.js';
import { briefOf } from './archive.js';
import { oneLine } from './memory-digest.js';
import {
  firstErrorLine, gateExit, LIMITS, normalizeDedupe, parseItemRef, structuralCode,
  type CaptureEvent, type Derived, type DerivedItem, type EpisodeData, type HistoryEntry, type ItemKind,
} from './memory-schema.js';

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** The last max characters, so a gate tail keeps its exit line. */
const cutFront = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max + 1)}` : s);
const firstSentence = (s?: string) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t && (/^.*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t);
};

function item(kind: ItemKind, text: string, author: DerivedItem['author'], body?: string, dedupe = normalizeDedupe(kind, text)): DerivedItem {
  return { kind, text, ...(body ? { body } : {}), author, dedupe };
}

/** One item per dedupe key, the first kept. */
const distinct = (items: DerivedItem[]) => items.filter((x, i) => items.findIndex((y) => y.kind === x.kind && y.dedupe === x.dedupe) === i);

const TOOLS = new Set(['tsc', 'vitest', 'jest', 'eslint', 'prettier', 'playwright']);
// Options that only select, filter or format what a check runs. Anything else is refused: config files, preloads,
// wrappers, reporters, pagers and shells (--node-options, --config, -exec, -toolexec, -f, -p, git grep -O) can all run code.
const SAFE_FLAGS = new Set([
  '--', '--noEmit', '--locked', '--frozen', '--offline', '--all-targets', '--all-features', '--workspace', '--release', '--no-fail-fast',
  '--check', '--quiet', '-q', '--verbose', '-v', '--silent', '--run', '--bail', '--passWithNoTests', '--ci', '--coverage', '--json',
  '--max-warnings', '--oneline', '--stat', '--name-only', '--name-status', '--cached', '--staged', '--short', '-n', '-race', '-short',
  '-count', '-run', '-x', '-k', '-t',
]);
/** A package script name, as in test:unit. */
const SCRIPT = /^[\w:.-]+$/;
/** A path, ref, target or test name: no quotes, backslashes, '=' (so no VAR= or --opt=), ':' or ','. */
const ARG = /^[\w./@^~+-]+$/;
const isScript = (s?: string) => !!s && SCRIPT.test(s) && !s.startsWith('-');
const isArg = (s?: string) => !!s && ARG.test(s) && !/^[-~]/.test(s);

/** How many leading tokens name an allowlisted command and subcommand; 0 when they do not. */
function head([c, a, b]: string[]): number {
  switch (c) {
    case 'npm': return a === 'test' || a === 't' ? 2 : (a === 'run' || a === 'run-script') && isScript(b) ? 3 : 0;
    case 'pnpm': case 'yarn': case 'bun':
      return a === 'test' ? 2 : (a === 'run' && isScript(b)) || (a === 'exec' && c !== 'bun' && TOOLS.has(b ?? '')) ? 3 : 0;
    case 'npx': return a === '--no-install' ? (TOOLS.has(b ?? '') ? 3 : 0) : TOOLS.has(a ?? '') ? 2 : 0;
    case 'node': return a === '--test' || (isArg(a) && /\.(?:js|mjs|cjs|ts)$/.test(a ?? '')) ? 2 : 0;
    case 'tsx': return isArg(a) ? 2 : 0;
    case 'cargo': return ['test', 'check', 'build', 'clippy', 'fmt'].includes(a ?? '') ? 2 : 0;
    case 'go': return ['test', 'vet', 'build'].includes(a ?? '') ? 2 : 0;
    case 'make': return isArg(a) ? 2 : 0;
    case 'pytest': return 1;
    case 'python': case 'python3': return a === '-m' && (b === 'pytest' || b === 'unittest') ? 3 : 0;
    case 'uv': return a === 'run' && b === 'pytest' ? 3 : 0;
    case 'git': return ['status', 'diff', 'log', 'show', 'grep', 'ls-files', 'rev-parse', 'blame'].includes(a ?? '') ? 2 : 0;
    case 'tl':
      // sessions clean deletes; only the bare listing and its path lookup are read-only.
      if (a === 'sessions') return b === 'path' ? 3 : b === undefined ? 2 : 0;
      if (a === 'memory') return b === 'search' || b === 'show' ? 3 : 0;
      return ['list', 'ps', 'config', 'gate', 'diff', 'history', 'transcript', 'read', 'status', 'log'].includes(a ?? '') ? 2 : 0;
    case 'claude': return a === 'plugin' && (b === 'validate' || b === 'test') ? 3 : 0;
    default: return 0;
  }
}

/**
 * Whether a command an agent reported is safe to replay as a procedure: the D4 rule 5 allowlist of commands, then only
 * SAFE_FLAGS (and tsc's -p) and plain arguments.
 */
export function isProcedure(span: string): boolean {
  // Printable ASCII with single spaces: no \r, tabs or Unicode spaces that a shell might split differently.
  if (/[^ -~]/.test(span)) return false;
  const cmd = span.trim();
  if (!cmd || cmd.length > LIMITS.procedure.span || /\s\s|[|;&`<>]|\$\(/.test(cmd)) return false;
  const args = cmd.split(' ');
  const n = head(args);
  const tsc = args.slice(0, n).includes('tsc');
  return n > 0 && args.slice(n).every((x) => SAFE_FLAGS.has(x) || (tsc && (x === '-p' || x === '--project')) || isArg(x));
}

/** The outcome's data, cut until its JSON fits LIMITS.outcome.episode: verified, summary, note, then list entries. */
function outcomeData(o: EpisodeData['outcome']): EpisodeData['outcome'] {
  const data = { ...o, ...(o.openQuestions ? { openQuestions: o.openQuestions.slice(0, LIMITS.outcome.openQuestions).map((q) => cut(q, LIMITS.outcome.openQuestion)) } : {}) };
  const excess = () => JSON.stringify(data).length - LIMITS.outcome.episode;
  for (const k of ['verified', 'summary', 'note'] as const) {
    while (excess() > 0 && data[k]) data[k] = data[k].length - excess() - 1 > 0 ? cut(data[k], data[k].length - excess()) : '';
  }
  for (const k of ['changedFiles', 'openQuestions'] as const) while (excess() > 0 && data[k]?.length) data[k] = data[k].slice(0, -1);
  return data;
}

const EXIT = /^(?:exited with \d+|stopped by \S+ \(time limit [\d.]+ minutes\))$/;
/** The tail's last line when it is exactly the exit line runCommands writes for this command (worktree.ts). */
function exitLine(command: string, tail: string): string | undefined {
  const line = gateExit(tail);
  return line?.startsWith(`${command}: `) && EXIT.test(line.slice(command.length + 2)) ? line : undefined;
}

const failures = (history: HistoryEntry[]) =>
  history.flatMap((h) => (h.kind === 'gate' && !h.data.ok ? [h.data] : []));

function outcomeItems(o: EpisodeData['outcome'], history: HistoryEntry[], nodeId?: string): DerivedItem[] {
  const items = (o.openQuestions ?? []).slice(0, LIMITS.outcome.openQuestions).map((q) => q.trim()).filter(Boolean)
    .map((q) => item('open_question', cut(q, LIMITS.outcome.openQuestion), 'agent'));
  const succeeded = o.outcome === 'succeeded' && o.gate !== 'failed';
  if (succeeded) {
    for (const [, span] of (o.verified ?? '').matchAll(/`([^`\n]+)`/g)) {
      if (isProcedure(span)) items.push(item('procedure', span.trim(), 'agent'));
    }
  }
  if (succeeded && o.gate === 'passed') {
    // Gate output is agent text (R2): author agent, eligible only because this node then passed.
    // The fix note is daemon facts (the node, the passing attempt) plus the files the agent reported; the summary describes
    // the task, not the fix, so it stays out.
    const attempt = history.flatMap((h) => (h.kind === 'gate' && h.data.ok ? [h.data.attempt] : [])).at(-1);
    const files = (o.changedFiles ?? []).slice(0, 5).map((f) => cut(oneLine(f), 120));
    const fixed = `\nFixed by ${nodeId ?? 'this node'}: the gate passed${attempt === undefined ? '' : ` on attempt ${attempt}`}.${files.length ? `\nFiles it reported changing: ${files.join(', ')}` : ''}`;
    for (const f of failures(history)) {
      const line = f.tail && firstErrorLine(f.tail);
      if (!line) continue;
      const note = fixed;
      items.push(item('pitfall', cut(`gate \`${f.command}\` failed: ${line}`, LIMITS.item.text), 'agent', cutFront(f.tail ?? '', LIMITS.item.body - note.length) + note));
    }
  }
  const last = failures(history).at(-1);
  if (o.outcome === 'failed' && o.gate === 'failed' && last) {
    // Unresolved: daemon facts only, the command, the daemon's exit line and one structural code. Keyed on the command
    // alone, so codes the agent's output chooses cannot fan out into new items.
    // prune: never retired when this node later passes; it stays until the human forgets it or eviction takes it.
    const tail = last.tail ?? '';
    const code = structuralCode(tail);
    const facts = [exitLine(last.command, tail), code].filter(Boolean).join(' · ');
    const dedupe = `GATE:${normalizeDedupe('pitfall', last.command)}`;
    const note = '\nunresolved';
    items.push(item('pitfall', cut(`gate \`${last.command}\` failed${facts ? ` (${facts})` : ''}`, LIMITS.item.text), 'daemon', cutFront(tail, LIMITS.item.body - note.length) + note, dedupe));
  }
  return distinct(items);
}

/** The ids cited as [m<id>] anywhere in the outcome. */
function citesOf(o: EpisodeData['outcome']): number[] {
  const text = [o.note, o.summary, o.verified, ...(o.changedFiles ?? []), ...(o.openQuestions ?? [])].join('\n');
  return [...new Set([...text.matchAll(/\[m(\d+)\]/g)].map(([, d]) => parseItemRef(`m${d}`)).filter((id) => id !== undefined))];
}

// Git refs may hold | ; $( and more, and the spawner picks them: show a base name only when it is plainly a name.
const BRANCH = /^[\w./-]{1,80}$/;
const fateText = (a: ArchivedNode) =>
  a.branchFate === 'merged' ? `merged to task branch${a.base && BRANCH.test(a.base) ? ` ${a.base}` : ''}`
    : a.branchFate === 'kept' ? 'branch kept, unmerged' : a.branchFate === 'discarded' ? 'branch discarded' : undefined;
const verdict = (o?: Outcome) => (o ? `${o.outcome}${o.gate ? ` (gate ${o.gate})` : ''}` : 'no outcome');

function ledger(a: ArchivedNode): DerivedItem {
  const fate = fateText(a);
  const o = a.outcome;
  const succeeded = o?.outcome === 'succeeded' && o.gate !== 'failed';
  // A node can rename itself, so its title is agent text: only a succeeded node's line carries it.
  const text = succeeded
    ? `${cut(a.title.replace(/\s+/g, ' ').trim(), LIMITS.item.title)}: ${briefOf({ ...a, branchFate: undefined }) ?? verdict(o)}${fate ? ` (${fate})` : ''}`
    : `${a.id}: ${verdict(o)}${fate ? ` · ${fate}` : ''}`;
  const body = [
    a.prompt && cut(a.prompt.trim(), LIMITS.item.ledgerBrief),
    o?.summary,
    o?.changedFiles?.length && `Files: ${o.changedFiles.join(', ')}`,
    o?.verified && `Verified: ${o.verified}`,
  ].filter(Boolean).join('\n\n');
  return item('ledger', cut(text, LIMITS.item.text), succeeded ? 'agent' : 'daemon', cut(body, LIMITS.item.ledgerBody), a.id);
}

/** What one captured event records. history: the node's episodes since its previous outcome, oldest first. */
export function derive(event: CaptureEvent, history: HistoryEntry[], nodeId?: string): Derived {
  const { ts } = event;
  switch (event.type) {
    case 'outcome': {
      const { type: _, ts: __, ...o } = event;
      return { episode: { kind: 'outcome', ts, data: outcomeData(o) }, items: outcomeItems(o, history, nodeId), cites: citesOf(o) };
    }
    case 'gate': {
      const { ok, command, attempt, tail } = event;
      return { episode: { kind: 'gate', ts, data: { ok, command, attempt, ...(!ok && tail ? { tail: cutFront(tail, LIMITS.gateTail) } : {}) } }, items: [], cites: [] };
    }
    case 'close': {
      const a = event.archived;
      const data: EpisodeData['close'] = {
        spentUsd: a.spentUsd, createdAt: a.createdAt, closedAt: a.closedAt, branchFate: a.branchFate, base: a.base, outcome: a.outcome?.outcome, gate: a.outcome?.gate,
      };
      return { episode: { kind: 'close', ts, data }, items: [ledger(a)], cites: [] };
    }
    case 'spawn': { const { type: _, ts: __, ...data } = event; return { episode: { kind: 'spawn', ts, data }, items: [], cites: [] }; }
    case 'merge': { const { type: _, ts: __, ...data } = event; return { episode: { kind: 'merge', ts, data }, items: [], cites: [] }; }
    case 'human_send': { const { type: _, ts: __, ...data } = event; return { episode: { kind: 'human_send', ts, data }, items: [], cites: [] }; }
  }
}
