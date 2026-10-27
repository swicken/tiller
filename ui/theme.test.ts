import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseThemePref, resolveTheme, THEME_KEY, type ThemePref } from './theme';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

/** Browser stand-ins: a stored preference (or a throwing store), the OS appearance and its change listeners. */
function stubBrowser(stored: string | null | Error, systemLight = false) {
  const os = { light: systemLight, listeners: [] as (() => void)[] };
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal('localStorage', {
    getItem: () => { if (stored instanceof Error) throw stored; return stored; },
    setItem: vi.fn(),
  });
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return q === '(prefers-color-scheme: light)' && os.light; },
    addEventListener: (_: string, fn: () => void) => os.listeners.push(fn),
  }));
  vi.stubGlobal('document', { documentElement: root });
  const flipOs = (light: boolean) => { os.light = light; os.listeners.forEach((fn) => fn()); };
  return { root, flipOs };
}

afterEach(() => vi.unstubAllGlobals());

describe('preference', () => {
  it.each([null, 'junk', '', 'Light', 'system'])('reads %j as System', (raw) => expect(parseThemePref(raw)).toBe('system'));
  it.each(['light', 'dark'] as const)('keeps %s', (raw) => expect(parseThemePref(raw)).toBe(raw));

  it('resolves System from the OS and ignores the OS for an explicit choice', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    for (const os of [true, false]) {
      expect(resolveTheme('light', os)).toBe('light');
      expect(resolveTheme('dark', os)).toBe('dark');
    }
  });
});

describe('applying', () => {
  beforeEach(() => vi.resetModules());
  const load = () => import('./theme');

  it('falls back to System when storage throws', async () => {
    const { root } = stubBrowser(new Error('denied'), true);
    const theme = await load();
    expect(theme.themePref()).toBe('system');
    theme.startTheme();
    expect(root.dataset.theme).toBe('light');
  });

  it('sets data-theme, stores a choice and notifies subscribers only on a change', async () => {
    const { root } = stubBrowser('dark', true);
    const theme = await load();
    const seen: string[] = [];
    theme.onThemeChange((t) => seen.push(t));
    theme.startTheme();
    expect(root.dataset.theme).toBe('dark');
    theme.setThemePref('light');
    expect(root.dataset.theme).toBe('light');
    expect(localStorage.setItem).toHaveBeenCalledWith(THEME_KEY, 'light');
    theme.setThemePref('system'); // the OS is light too: no change to report
    expect(seen).toEqual(['light']); // no attribute already renders dark, so starting dark is no change
  });

  it('follows the OS only while the preference is System', async () => {
    const { root, flipOs } = stubBrowser(null, false);
    const theme = await load();
    const seen: string[] = [];
    const off = theme.onThemeChange((t) => seen.push(t));
    theme.startTheme();
    flipOs(true);
    expect(root.dataset.theme).toBe('light');
    theme.setThemePref('dark');
    flipOs(false);
    flipOs(true);
    expect(root.dataset.theme).toBe('dark');
    off();
    theme.setThemePref('system');
    expect(root.dataset.theme).toBe('light');
    expect(seen).toEqual(['light', 'dark']);
  });
});

describe('app window', () => {
  beforeEach(() => vi.resetModules());

  /** IN_APP comes from __TAURI_INTERNALS__ when the module loads, so stub window before importing. */
  async function loadIn(app: boolean, stored: string | null, systemLight = false) {
    const browser = stubBrowser(stored, systemLight);
    const invoke = vi.fn(() => Promise.resolve());
    vi.stubGlobal('window', app ? { __TAURI_INTERNALS__: { invoke } } : {});
    return { ...browser, invoke, theme: await import('./theme') };
  }

  it('sends the preference at startup and on each change, System as null', async () => {
    const { invoke, theme } = await loadIn(true, 'light');
    theme.startTheme();
    theme.setThemePref('dark');
    theme.setThemePref('system');
    expect(invoke.mock.calls).toEqual([
      ['set_app_theme', { theme: 'light' }],
      ['set_app_theme', { theme: 'dark' }],
      ['set_app_theme', { theme: null }],
    ]);
  });

  it('does not send an OS flip, whatever the preference', async () => {
    const { invoke, theme, flipOs, root } = await loadIn(true, 'light');
    theme.startTheme();
    flipOs(true);
    flipOs(false);
    expect(root.dataset.theme).toBe('light');
    theme.setThemePref('system');
    invoke.mockClear();
    flipOs(true);
    expect(root.dataset.theme).toBe('light');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('is not called in the browser', async () => {
    const { invoke, theme } = await loadIn(false, 'light');
    theme.startTheme();
    theme.setThemePref('dark');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the theme working when the call fails', async () => {
    const { invoke, theme, root } = await loadIn(true, 'dark');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error('denied')).mockImplementationOnce(() => { throw new Error('gone'); });
    theme.startTheme();
    theme.setThemePref('light');
    expect(root.dataset.theme).toBe('light');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });
});

it('index.html pre-paint script resolves every stored value and OS like theme.ts', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(read('./index.html'))?.[1];
  expect(script).toContain(`'${THEME_KEY}'`);
  for (const stored of [null, '', 'junk', 'system', 'light', 'dark', new Error('denied')]) {
    for (const os of [true, false]) {
      const { root } = stubBrowser(stored, os);
      new Function(script!)();
      const pref: ThemePref = stored instanceof Error ? 'system' : parseThemePref(stored);
      expect(root.dataset.theme, `${stored} on a ${os ? 'light' : 'dark'} OS`).toBe(resolveTheme(pref, os));
    }
  }
});

it('prefers-color-scheme is read only by theme.ts and the pre-paint script', () => {
  const files = globSync('**/*.{css,ts,tsx,html}', { cwd: fileURLToPath(new URL('.', import.meta.url)), exclude: ['node_modules/**', 'dist/**', '**/*.test.ts'] });
  expect(files.filter((f) => read(`./${f}`).includes('prefers-color-scheme')).sort()).toEqual(['index.html', 'theme.ts']);
});

// WCAG 2.x contrast of the light tokens, including the tints that badges, counts and diff rows mix over a surface.
describe('light contrast', () => {
  const block = /:root\[data-theme='light'\] \{([^}]*)\}/.exec(read('./theme.css'))![1];
  const token = (name: string) => {
    const hex = new RegExp(`--${name}: #([0-9a-f]{6});`).exec(block)?.[1];
    if (!hex) throw new Error(`--${name} is not a 6-digit hex in the light block`);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };
  const mix = (fg: number[], bg: number[], a: number) => fg.map((c, i) => c * a + bg[i] * (1 - a));
  const lum = (rgb: number[]) => {
    const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const tint = (name: string, pct: number, over: string) => mix(token(name), token(over), pct / 100);
  // [what, foreground, background, minimum]: 4.5 for text, 3 for focus rings and state dots.
  const pairs: [string, () => number[], () => number[], number][] = [
    ['body text', () => token('fg'), () => token('bg'), 4.5],
    ['text on panels', () => token('fg'), () => token('surface'), 4.5],
    ['text on buttons', () => token('fg'), () => token('surface-2'), 4.5],
    ['muted text', () => token('dim'), () => token('bg'), 4.5],
    ['muted text on panels', () => token('dim'), () => token('surface'), 4.5],
    ['counts and tags', () => token('dim'), () => token('surface-2'), 4.5],
    ['muted text on a selected row', () => token('dim'), () => token('sel'), 4.5],
    ['links', () => token('accent'), () => token('bg'), 4.5],
    ['primary button', () => token('accent-fg'), () => token('accent'), 4.5],
    ['.badge.working', () => token('working'), () => token('surface-2'), 4.5],
    ['.badge.done', () => token('done'), () => token('surface-2'), 4.5],
    ['.badge.errored', () => token('bad'), () => token('surface-2'), 4.5],
    ['.badge.needs', () => token('needs'), () => tint('needs', 16, 'surface'), 4.5],
    ['.count.warn', () => token('needs'), () => tint('needs', 18, 'surface'), 4.5],
    ['.count.bad', () => token('bad'), () => tint('bad', 18, 'surface'), 4.5],
    ['diff added count', () => token('done'), () => token('bg'), 4.5],
    ['diff removed count', () => token('bad'), () => token('bg'), 4.5],
    ['added diff row', () => token('fg'), () => tint('done', 14, 'bg'), 4.5],
    ['removed diff row', () => token('fg'), () => tint('bad', 14, 'bg'), 4.5],
    ['.warn text', () => token('needs'), () => token('bg'), 4.5],
    ['danger button', () => token('on-bad'), () => token('bad'), 4.5],
    ['focus ring', () => token('accent'), () => token('bg'), 3],
    ['idle dot', () => token('idle'), () => token('surface'), 3],
    ['working dot', () => token('working'), () => token('surface'), 3],
    ['needs dot', () => token('needs'), () => token('surface'), 3],
  ];
  it.each(pairs)('%s meets AA', (_, fg, bg, min) => expect(ratio(fg(), bg())).toBeGreaterThanOrEqual(min));
});
