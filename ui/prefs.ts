/** Per-viewer localStorage: it may be unavailable or throw, so a read falls back to null and a failed write is dropped. */
export function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* per-viewer convenience only */ }
}
