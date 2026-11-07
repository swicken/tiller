export const cwdBase = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() || cwd || '/';

export const titleFor = (needsYou: number) => (needsYou > 0 ? `(${needsYou}) Tiller` : 'Tiller');

/** A retention date: medium date and short time, in the viewer's locale. */
export const fmtDeleteDate = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
