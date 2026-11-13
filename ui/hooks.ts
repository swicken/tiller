import { useEffect, useSyncExternalStore } from 'react';
import { dndActive } from '../src/shared/protocol';
import { send } from './conn';
import { titleFor } from './format';
import { getState, selectNode, useStore } from './store';
import { trayState } from './tray';
import { syncUrl } from './url';

/** One shared clock so every age label updates together. */
let now = Date.now();
const subs = new Set<() => void>();
setInterval(() => { now = Date.now(); subs.forEach((f) => f()); }, 10_000);
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useNow = () => useSyncExternalStore(subscribe, () => now);

export type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: object) => Promise<unknown> } };

/** Do not disturb for an hour, or off when it is on. */
export const toggleDnd = () => send(dndActive(getState().dnd, Date.now()) ? { t: 'dnd', on: false } : { t: 'dnd', on: true, minutes: 60 });

/** What the app's menu bar item calls on a click (src-tauri/src/lib.rs on_tray_menu). */
(window as { __tltray?: (action: string, id?: string) => void }).__tltray = (action, id) => {
  if (action === 'select' && id) selectNode(id);
  else if (action === 'dnd') toggleDnd();
};

/**
 * "(2) tiller" in the document title (and the Dock badge and menu bar item in the app) while nodes or questions need you; keeps
 * ?node= in step with the selection.
 */
export function useDocumentSync() {
  const selected = useStore((s) => s.selected);
  const now = useNow();
  // A string, so the store re-renders only when the tray actually changes.
  const tray = useStore((s) => JSON.stringify({ ...trayState(s.order.map((id) => s.nodes[id]!), Object.values(s.questions)), dnd: dndActive(s.dnd, now) }));
  useEffect(() => {
    const t: ReturnType<typeof trayState> = JSON.parse(tray), needs = t.items.length, tauri = (window as TauriWindow).__TAURI_INTERNALS__;
    document.title = titleFor(needs);
    tauri?.invoke('plugin:window|set_badge_count', { count: needs || null }).catch(() => {});
    tauri?.invoke('set_tray', t).catch(() => {});
  }, [tray]);
  useEffect(() => { syncUrl(selected); }, [selected]);
}
