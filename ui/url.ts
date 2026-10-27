import { readPref, writePref } from './prefs';

/** URL parameters, read once at load. `?k=` is moved to localStorage and removed from the address bar; `?node=` is kept in sync with the selection. */
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

export const wantedNode = params.get('node') ?? undefined;
const urlKey = params.get('k');

export function token(): string {
  if (urlKey) {
    writePref('tl.k', urlKey); // storage unavailable: the in-memory copy still works
    return urlKey;
  }
  return readPref('tl.k') ?? '';
}

export function syncUrl(nodeId: string | null) {
  const q = nodeId ? `?node=${encodeURIComponent(nodeId)}` : '';
  history.replaceState(null, '', location.pathname + q);
}

/** The Tauri shell adds `app=1` to the URL; `__TAURI_INTERNALS__` is the fallback signal. */
export const IN_APP = params.has('app') || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
