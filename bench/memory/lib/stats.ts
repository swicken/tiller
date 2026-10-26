// Paired statistics for the bench (plan §4), with no dependency: the exact McNemar test, the Wilcoxon signed-rank test
// and percentile bootstrap CIs over pairs, from a seeded PRNG so a re-score gives the same intervals.

/** mulberry32: a small seeded PRNG. */
export function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** The two-sided exact McNemar p from the discordant counts: 2 · P(X ≤ min(b, c)) for X ~ Bin(b + c, ½), at most 1. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  let tail = 0, coef = 1; // coef = C(n, k)
  for (let k = 0; k <= Math.min(b, c); k++) {
    tail += coef;
    coef = (coef * (n - k)) / (k + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/**
 * The two-sided Wilcoxon signed-rank p for paired differences: zeros dropped, tied |d| given their mean rank. Exact
 * (every sign assignment) up to 20 non-zero differences, else the normal approximation with the tie correction.
 */
export function wilcoxon(diffs: number[]): number {
  const d = diffs.filter((x) => x !== 0);
  const n = d.length;
  if (!n) return 1;
  const order = d.map((x, i) => ({ a: Math.abs(x), i })).sort((x, y) => x.a - y.a);
  const ranks = new Array<number>(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && order[j + 1].a === order[i].a) j++;
    for (let k = i; k <= j; k++) ranks[order[k].i] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const wPlus = d.reduce((s, x, i) => s + (x > 0 ? ranks[i] : 0), 0);
  const total = ranks.reduce((a, b) => a + b, 0);
  const extreme = Math.min(wPlus, total - wPlus);
  if (n <= 20) {
    let count = 0;
    for (let mask = 0; mask < 1 << n; mask++) {
      let w = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) w += ranks[i];
      if (Math.min(w, total - w) <= extreme + 1e-9) count++;
    }
    return Math.min(1, count / 2 ** n);
  }
  const mu = total / 2;
  const sd = Math.sqrt(ranks.reduce((s, r) => s + r * r, 0) / 4);
  return Math.min(1, 2 * normalCdf(-Math.abs(wPlus - mu) / sd));
}

/** Φ(z), by the Abramowitz-Stegun 7.1.26 erf approximation (error < 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** The 95% percentile bootstrap CI of stat over resamples of the pairs (plan §4: 10,000 resamples). */
export function bootstrapCi<T>(pairs: T[], stat: (sample: T[]) => number, resamples = 10_000, seed = 4104): [number, number] {
  if (!pairs.length) return [NaN, NaN];
  const next = rng(seed);
  const values: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const v = stat(Array.from(pairs, () => pairs[Math.floor(next() * pairs.length)]));
    if (Number.isFinite(v)) values.push(v);
  }
  values.sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))];
  return [at(0.025), at(0.975)];
}
