import type { TauriWindow } from './hooks';
import { readPref, writePref } from './prefs';
import { IN_APP } from './url';

// The pre-paint script in index.html repeats the key, the values and the resolution rule; theme.test.ts keeps them in step.
export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'tl.theme';
const SYSTEM_LIGHT = '(prefers-color-scheme: light)';

/** Anything but 'light' or 'dark' means System, so a missing or corrupt value is safe. */
export const parseThemePref = (raw: string | null): ThemePref => (raw === 'light' || raw === 'dark' ? raw : 'system');
export const resolveTheme = (pref: ThemePref, systemLight: boolean): Theme =>
  pref === 'system' ? (systemLight ? 'light' : 'dark') : pref;

let pref = parseThemePref(readPref(THEME_KEY));
const listeners = new Set<(theme: Theme) => void>();

/** The applied theme: the data-theme attribute, which the pre-paint script sets before any module runs. */
export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
export const themePref = () => pref;

/** Resolves the preference, sets data-theme and tells subscribers when the theme changed. */
export function applyTheme() {
  const prev = currentTheme();
  const next = resolveTheme(pref, matchMedia(SYSTEM_LIGHT).matches);
  document.documentElement.dataset.theme = next;
  if (next !== prev) listeners.forEach((fn) => fn(next));
}

/**
 * Gives the app window the preference, so the native title bar and traffic lights match; System passes null so the
 * window follows the OS. Only the preference goes native, never an OS flip, so the OS listener cannot loop through it.
 */
function syncAppTheme() {
  if (!IN_APP) return;
  try {
    (window as TauriWindow).__TAURI_INTERNALS__?.invoke('set_app_theme', { theme: pref === 'system' ? null : pref })
      .catch((e) => console.warn('set_app_theme failed', e));
  } catch (e) { console.warn('set_app_theme failed', e); }
}

export function setThemePref(next: ThemePref) {
  pref = next;
  writePref(THEME_KEY, next);
  syncAppTheme();
  applyTheme();
}

/** Calls fn with each new theme; returns the unsubscribe. */
export function onThemeChange(fn: (theme: Theme) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Applies the stored preference and follows the OS while it is System. Called once at startup. */
export function startTheme() {
  matchMedia(SYSTEM_LIGHT).addEventListener('change', () => { if (pref === 'system') applyTheme(); });
  syncAppTheme();
  applyTheme();
}
