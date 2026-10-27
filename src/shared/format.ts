import type { Outcome, RateLimit, Usage } from './protocol.js';

const FAMILY =/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/;

/** "claude-opus-5-5" -> "opus 5.5"; other ids lose a leading "claude-". */
export function shortModel(model?: string): string {
  if (!model) return '';
  const m = FAMILY.exec(model);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : model.replace(/^claude-/, '');
}

export const shortEffort = (level: string): string => (level === 'medium' ? 'med' : level);

export function fmtAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export type CtxLevel = 'ok' | 'warn' | 'bad';
/** Context use: green below 50%, amber up to 80%, red above. */
export const ctxLevel = (pct: number): CtxLevel => (pct < 50 ? 'ok' : pct <= 80 ? 'warn' : 'bad');

export const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

/** Rate-limit use: amber above 80%, red above 95%. */
const usageLevel = (pct: number): CtxLevel => (pct > 95 ? 'bad' : pct > 80 ? 'warn' : 'ok');

/** A rate-limit reading older than this is stale. */
const STALE_MS = 300_000;
export const limitResetPassed = (l: RateLimit, now: number): boolean => !!l.resetsAt && Date.parse(l.resetsAt) <= now;
export const limitStale = (l: RateLimit, now: number): boolean => l.observedAt !== undefined && now - l.observedAt > STALE_MS;

const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus pool', seven_day_sonnet: '7d Sonnet pool' };

/** Local "14:30" within a day of `now`, else "Wed 14:30"; '' for a bad timestamp. */
function fmtReset(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (now - d.getTime() >= 86_400_000 || d.getTime() - now >= 7 * 86_400_000) return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
  return d.getTime() - now < 86_400_000 ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}

/** One part per window, such as "5h 42% · resets 14:30"; compact leaves out the reset. Join the parts with " · ". */
export function usageParts(limits: readonly RateLimit[], compact = false, now = Date.now()): { text: string; level: CtxLevel }[] {
  return limits.map((l) => {
    if (limitResetPassed(l, now)) return { text: `${WINDOWS[l.kind] ?? l.kind} · reset passed · awaiting report`, level: 'warn' };
    const reset = compact || !l.resetsAt ? '' : fmtReset(l.resetsAt, now);
    return { text: `${WINDOWS[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%${reset && ` · resets ${reset}`}${limitStale(l, now) ? ` · stale (${fmtAge(now - l.observedAt!)} ago)` : ''}`, level: usageLevel(l.percentUsed) };
  });
}

/** The line list_nodes and `tl usage` print. */
export function usageLine(u: Usage | undefined, now = Date.now()): string {
  if (!u) return 'usage: no report yet';
  return `usage${u.account ? ` (${u.account})` : ''}: ${usageParts(u.rateLimits, false, now).map((p) => p.text).join(' · ')} (from ${u.nodeId}, ${fmtAge(now - u.at)} ago)`;
}

/** A reported outcome as one line: "succeeded (gate passed): <summary, else note>", the text capped at 200 characters. */
export function outcomeLine(o: Pick<Outcome, 'outcome' | 'gate' | 'summary' | 'note'>): string {
  const text = (o.summary || o.note)?.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${o.outcome}${o.gate ? ` (gate ${o.gate})` : ''}${text ? `: ${text}` : ''}`;
}
