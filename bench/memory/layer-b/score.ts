// Layer B scoring (bench plan §3.4-3.6, §4): what one arm's node did, from objective sources only, and the paired
// summary of a run. Raw arm data is kept in results.json, so `--report` re-scores a run with no new LLM calls.
import type { MemoryInjectionView, Outcome } from '../../../src/shared/protocol.js';
import { bootstrapCi, mcnemarExact, mean, median, wilcoxon } from '../lib/stats.js';
import type { Scenario } from './scenarios.js';

/** One line of an arm's call log (repos.ts LOG_SH). */
export interface Call { ts: number; cmd: string; arg: string; gate: string }
/** One tool call from the transcript, with the input fields scoring reads. */
export interface ToolCall { at: number; name: string; file?: string; command?: string }

/** Everything the bench recorded about one arm's node. */
export interface ArmRaw {
  label: string;
  mode: 'off' | 'on' | 'tools';
  nodeId?: string;
  /** How waiting ended (Client.awaitOutcome), or 'error' when the bench itself failed. */
  end: string;
  detail?: string;
  errored?: boolean;
  outcome?: Outcome;
  createdAt?: number;
  endedAt: number;
  spentUsd?: number;
  /** The daemon's gate events for the node (events.jsonl, H5), in order. */
  gates: { ts: number; ok: boolean }[];
  calls: Call[];
  tools: ToolCall[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  injections: MemoryInjectionView[];
  /** Files changed or added against R1 (the origin-base tag), committed or not. */
  diff: string[];
  /** Whether ~/.claude/projects/<slug of the repo>/memory existed at phase-2 start (§3.4: must be false). */
  autoMemory: boolean;
}

export interface ArmScore {
  /** Why the arm's trial is void (§3.4 rule 5) or invalid (rule 2); undefined when it counts. */
  voidReason?: string;
  success: boolean;
  firstPassGate: boolean;
  gateAttempts: number;
  /** The first run of the gate script by anyone, the agent's own included, passed (from the call log). */
  firstGateRunOk: boolean;
  /** Gate script runs that were not the daemon's (the agent ran it by hand). */
  manualGateRuns: number;
  toolCalls: number;
  /** S2: tool calls before the first verify run of the agent's own, else before the first gate, else all. */
  toolCallsToVerify: number;
  verifiedBeforeGate: boolean;
  npmTestBeforeVerify: boolean;
  /** S2: the outcome's verified names tools/verify.mjs. */
  verifyNamed: boolean;
  /** CHANGELOG.md is in the final diff (S5a: created although the changelog was retired). */
  changelogTouched: boolean;
  /** S1: CHANGELOG.md was edited before the first gate run. */
  changelogBeforeGate: boolean;
  wallSec: number;
  spentUsd: number;
  tokens: number;
  injected: number[];
  targetsInjected: boolean;
  cited: number[];
  memoryCalls: number;
}

const firstTs = (calls: Call[], cmd: string, gate = '') => calls.find((c) => c.cmd === cmd && c.gate === gate)?.ts;
const MEMORY_TOOL = /__memory_(?:search|get|add|forget)$/;
const writesChangelog = (t: ToolCall) => (t.file?.endsWith('CHANGELOG.md') ?? false)
  || (!!t.command?.includes('CHANGELOG.md') && /(?:^|[^<>2&])>|sed -i|\btee\b|cat <</.test(t.command));

export function scoreArm(a: ArmRaw, targets: number[]): ArmScore {
  const o = a.outcome;
  const success = o?.outcome === 'succeeded' && o.gate !== 'failed';
  const firstGate = a.gates[0]?.ts ?? Infinity;
  const verify = firstTs(a.calls, 'verify');
  const verifiedBeforeGate = verify !== undefined && verify < firstGate;
  const before = (ts: number) => a.tools.filter((t) => t.at < ts).length;
  const injected = a.injections.find((j) => j.cause !== 'resume' && j.arm === 'on')?.itemIds ?? [];
  const text = [o?.note, o?.summary, o?.verified, ...(o?.openQuestions ?? [])].join('\n');
  const cites = [...new Set([...text.matchAll(/\[m(\d+)\]/g)].map(([, d]) => Number(d)))];
  return {
    voidReason: voidReason(a, targets),
    success,
    firstPassGate: success && a.gates[0]?.ok === true && o?.gate === 'passed',
    gateAttempts: a.gates.length,
    firstGateRunOk: a.calls.find((c) => c.cmd === 'gate-exit')?.arg === '0',
    manualGateRuns: Math.max(0, a.calls.filter((c) => c.cmd === 'gate').length - a.gates.length),
    toolCalls: a.tools.length,
    toolCallsToVerify: before(verifiedBeforeGate ? verify : firstGate),
    verifiedBeforeGate,
    npmTestBeforeVerify: a.calls.some((c) => c.cmd === 'npm-test' && c.ts < Math.min(verify ?? Infinity, firstGate)),
    verifyNamed: !!o?.verified?.includes('tools/verify.mjs'),
    changelogTouched: a.diff.includes('CHANGELOG.md'),
    changelogBeforeGate: a.tools.some((t) => t.at < firstGate && writesChangelog(t)),
    wallSec: a.createdAt ? ((o?.at ?? a.endedAt) - a.createdAt) / 1000 : NaN,
    spentUsd: a.spentUsd ?? NaN,
    tokens: a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite,
    injected,
    targetsInjected: targets.every((id) => injected.includes(id)),
    cited: cites.filter((id) => injected.includes(id)),
    memoryCalls: a.tools.filter((t) => MEMORY_TOOL.test(t.name)).length,
  };
}

/** §3.4 rule 5 (infra failures void a pair) and rule 2 (the injection log proves what each arm got). */
function voidReason(a: ArmRaw, targets: number[]): string | undefined {
  if (a.autoMemory) return 'Claude auto-memory existed for the phase-2 path';
  if (['error', 'vanished', 'exited', 'blocked'].includes(a.end)) return `${a.end}: ${a.detail ?? ''}`.trim();
  if (a.errored && !a.outcome) return `the turn ended in an API error: ${a.detail ?? ''}`.trim();
  if (!a.tools.length) return 'no tool call';
  const fresh = a.injections.filter((j) => j.cause !== 'resume');
  if (a.mode === 'off' && (fresh.length || a.tools.some((t) => MEMORY_TOOL.test(t.name)))) return 'invalid: the off arm saw memory';
  if (a.mode === 'on' && (fresh.length !== 1 || fresh[0].arm !== 'on' || !targets.every((id) => fresh[0].itemIds.includes(id)))) {
    return 'invalid: digest not delivered';
  }
  if (a.mode === 'tools' && (fresh.length !== 1 || fresh[0].arm !== 'off')) return 'invalid: tools arm injection row missing';
  return undefined;
}

// --- The summary of one run ---

export interface Trial { trial: number; attempt: number; startOrder: string[]; inputsHash: string; targets: number[]; shadow: number[]; arms: ArmRaw[] }

interface Paired { metric: string; a: number; b: number }
export interface MetricSummary {
  metric: string; kind: 'binary' | 'count';
  /** Arm means (binary: rates) and medians. */
  meanA: number; meanB: number; medianA: number; medianB: number;
  /** b − a, paired: the mean difference for binary metrics, the median difference for counts, with its 95% bootstrap CI. */
  diff: number; ci95: [number, number];
  /** Binary: the exact McNemar p and the discordant pairs; counts: the Wilcoxon signed-rank p. */
  p: number; discordant?: { bBetter: number; aBetter: number };
  /** Counts: the median ratio b/a over pairs where both are positive, with its CI (§4). */
  medianRatio?: number; ratioCi95?: [number, number];
}

export interface RunSummary {
  arms: [string, string];
  pairs: number;
  voids: number;
  voidReasons: string[];
  primary: MetricSummary & { better: 'higher' | 'lower'; margin?: number; verdict: string };
  secondary: MetricSummary[];
  validity: { offTrapHitRate: number; offFinalSuccess: number; valid: boolean | null; note: string };
  /** The on arm's injected items: how many outcomes cited one, and how many arms called a memory tool. */
  cites: number; memoryToolArms: number;
  costUsd: number; tokens: number; perNodeUsd: number;
}

function metric(name: string, kind: 'binary' | 'count', pairs: Paired[]): MetricSummary {
  const a = pairs.map((p) => p.a), b = pairs.map((p) => p.b);
  if (kind === 'binary') {
    const bBetter = pairs.filter((p) => p.b > p.a).length, aBetter = pairs.filter((p) => p.a > p.b).length;
    return {
      metric: name, kind, meanA: mean(a), meanB: mean(b), medianA: median(a), medianB: median(b),
      diff: mean(b) - mean(a), ci95: bootstrapCi(pairs, (s) => mean(s.map((p) => p.b - p.a))),
      p: mcnemarExact(bBetter, aBetter), discordant: { bBetter, aBetter },
    };
  }
  const finite = pairs.filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b));
  const pos = finite.filter((p) => p.a > 0 && p.b > 0);
  const ratio = (s: Paired[]) => Math.exp(median(s.map((p) => Math.log(p.b / p.a))));
  return {
    metric: name, kind, meanA: mean(finite.map((p) => p.a)), meanB: mean(finite.map((p) => p.b)),
    medianA: median(finite.map((p) => p.a)), medianB: median(finite.map((p) => p.b)),
    diff: median(finite.map((p) => p.b - p.a)), ci95: bootstrapCi(finite, (s) => median(s.map((p) => p.b - p.a))),
    p: wilcoxon(finite.map((p) => p.b - p.a)),
    ...(pos.length ? { medianRatio: ratio(pos), ratioCi95: bootstrapCi(pos, ratio) } : {}),
  };
}

const SECONDARY: { key: keyof ArmScore; kind: 'binary' | 'count' }[] = [
  { key: 'success', kind: 'binary' }, { key: 'firstPassGate', kind: 'binary' }, { key: 'firstGateRunOk', kind: 'binary' }, { key: 'gateAttempts', kind: 'count' },
  { key: 'manualGateRuns', kind: 'count' },
  { key: 'toolCalls', kind: 'count' }, { key: 'toolCallsToVerify', kind: 'count' }, { key: 'verifiedBeforeGate', kind: 'binary' },
  { key: 'npmTestBeforeVerify', kind: 'binary' }, { key: 'changelogBeforeGate', kind: 'binary' }, { key: 'changelogTouched', kind: 'binary' },
  { key: 'wallSec', kind: 'count' }, { key: 'spentUsd', kind: 'count' }, { key: 'tokens', kind: 'count' }, { key: 'memoryCalls', kind: 'count' },
];

/** The paired summary of a run's trials: arm B (the second, `on` in the standard run) against arm A. */
export function summarize(s: Scenario, trials: Trial[]): RunSummary {
  const latest = [...new Map(trials.map((t) => [t.trial, t])).values()]; // a re-run pair replaces its void attempt
  const scored = latest.map((t) => ({ t, scores: t.arms.map((a) => scoreArm(a, t.targets)) }));
  const ok = scored.filter((x) => x.scores.every((sc) => !sc.voidReason));
  const voidReasons = trials.flatMap((t) => t.arms.map((a) => scoreArm(a, t.targets).voidReason).filter((r): r is string => !!r)
    .map((r) => `t${t.trial}#${t.attempt}: ${r}`));
  const num = (v: unknown) => (typeof v === 'boolean' ? Number(v) : (v as number));
  const pairs = (key: keyof ArmScore): Paired[] => ok.map(({ scores: [a, b] }) => ({ metric: key, a: num(a[key]), b: num(b[key]) }));
  const p = s.primary;
  const primary = metric(p.key, p.kind, pairs(p.key));
  const offScores = ok.map(({ scores }) => scores[0]);
  const harm = s.claim === 5;
  const offTrapHitRate = mean(offScores.map((x) => Number(s.trapHit(x))));
  const offFinalSuccess = mean(offScores.map((x) => Number(x.success)));
  const valid = harm ? null : offTrapHitRate >= 0.5 && offFinalSuccess >= 0.7;
  const tooManyVoids = latest.length > 0 && (latest.length - ok.length) / latest.length > 0.2;
  const improved = p.better === 'higher' ? primary.diff > 0 : primary.diff < 0;
  const excludesZero = primary.ci95[0] > 0 || primary.ci95[1] < 0;
  let verdict: string;
  if (tooManyVoids || valid === false) verdict = 'invalid';
  else if (p.margin !== undefined) {
    // Non-inferiority (S5d): the on arm may not be worse than off by more than the margin at the CI's worse end.
    const worst = p.better === 'higher' ? primary.ci95[0] : -primary.ci95[1];
    verdict = worst >= -p.margin ? 'non-inferior' : 'non-inferiority not shown';
  } else if (harm) verdict = !improved && primary.diff !== 0 && excludesZero ? 'harm' : 'no detectable harm';
  else verdict = improved && (primary.p < 0.05 || excludesZero) ? 'benefit' : !improved && excludesZero ? 'harm' : 'no detectable effect';
  const all = latest.flatMap((t) => t.arms);
  const costUsd = trials.flatMap((t) => t.arms).reduce((sum, a) => sum + (a.spentUsd ?? 0), 0);
  const on = ok.map(({ scores }) => scores[1]);
  return {
    arms: [latest[0]?.arms[0]?.label ?? 'a', latest[0]?.arms[1]?.label ?? 'b'],
    pairs: ok.length, voids: latest.length - ok.length, voidReasons,
    primary: { ...primary, better: p.better, ...(p.margin !== undefined ? { margin: p.margin } : {}), verdict },
    secondary: SECONDARY.filter((m) => m.key !== p.key).map((m) => metric(m.key, m.kind, pairs(m.key))),
    validity: {
      offTrapHitRate, offFinalSuccess, valid,
      note: harm ? 'harm scenario: §3.5 trap validity does not apply' : `trap bites ≥ 50%: ${offTrapHitRate >= 0.5}; fixable ≥ 70%: ${offFinalSuccess >= 0.7}`,
    },
    cites: on.filter((x) => x.cited.length).length, memoryToolArms: on.filter((x) => x.memoryCalls > 0).length,
    costUsd, tokens: all.reduce((sum, a) => sum + a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite, 0),
    perNodeUsd: costUsd / Math.max(1, trials.flatMap((t) => t.arms).filter((a) => a.spentUsd !== undefined).length),
  };
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

/** The §3.7 summary table row plus the secondaries, as Markdown. */
export function summaryMarkdown(s: Scenario, model: string, r: RunSummary): string {
  const p = r.primary;
  const show = (m: MetricSummary) => (m.kind === 'binary'
    ? `${f(m.meanA)} → ${f(m.meanB)} (Δ ${f(m.diff)}, 95% CI [${f(m.ci95[0])}, ${f(m.ci95[1])}], McNemar p ${f(m.p, 3)}, discordant ${m.discordant!.bBetter}:${m.discordant!.aBetter})`
    : `median ${f(m.medianA, 1)} → ${f(m.medianB, 1)} (paired median Δ ${f(m.diff, 1)}, 95% CI [${f(m.ci95[0], 1)}, ${f(m.ci95[1], 1)}]${m.medianRatio !== undefined ? `, ratio ${f(m.medianRatio)} [${f(m.ratioCi95![0])}, ${f(m.ratioCi95![1])}]` : ''}, Wilcoxon p ${f(m.p, 3)})`);
  return [
    `### ${s.id} ${s.name} (${model}, ${r.arms[0]} vs ${r.arms[1]})`,
    '',
    `- N = ${r.pairs} pairs (${r.voids} void${r.voids === 1 ? '' : 's'})${r.voidReasons.length ? `; void/invalid arms: ${r.voidReasons.join('; ')}` : ''}`,
    `- **Primary ${p.metric}** (${p.better} is better${p.margin !== undefined ? `, margin ${p.margin}` : ''}): ${show(p)} → **${p.verdict}**`,
    `- Validity: off trap-hit ${f(r.validity.offTrapHitRate)}, off final success ${f(r.validity.offFinalSuccess)} (${r.validity.note})`,
    `- ${r.arms[1]} arm: ${r.cites}/${r.pairs} outcomes cited an injected item; ${r.memoryToolArms}/${r.pairs} called a memory tool`,
    `- Spend $${f(r.costUsd)} (≈ $${f(r.perNodeUsd, 3)}/node), ${(r.tokens / 1e6).toFixed(2)}M tokens`,
    '- Secondary:',
    ...r.secondary.map((m) => `  - ${m.metric}: ${show(m)}`),
    '',
  ].join('\n');
}
