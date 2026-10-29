import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { send } from './conn';
import { ActionMenu, actionsFor } from './controls/ActionButtons';
import { StateDot } from './controls/Bits';
import { Icon } from './controls/icons';
import { RenameInput } from './controls/RenameInput';
import { roots, sessions } from './sidebar/sessions';
import { arrangeSessions, getState, openDialog, selectSession, setRenaming, useStore } from './store';

/** How far a pressed tab moves before it is dragged rather than clicked, in pixels. */
const DRAG_START = 5;

/** Show the tabs in this order (root ids) and save it in the daemon, which tells the other clients. */
function saveOrder(ids: string[]) {
  arrangeSessions(ids);
  send({ t: 'sessionOrder', ids });
}

/** Cmd+Shift+[ / ]: select the previous or next session tab, wrapping around. */
export function stepSession(dir: 1 | -1) {
  const { nodes, order, session } = getState();
  const list = sessions(nodes, order);
  if (!list.length) return;
  const i = list.findIndex((s) => s.root.id === session);
  const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  selectSession(list[next].root.id);
}

/** Cmd+Shift+1..8: select the Nth session tab, if there is one; Cmd+Shift+9 selects the last, as browsers do. */
export function nthSession(n: number): boolean {
  const { nodes, order } = getState();
  const list = sessions(nodes, order);
  const s = n === 9 ? list.at(-1) : list[n - 1];
  if (s) selectSession(s.root.id);
  return !!s;
}

/** Cmd+Shift+Opt+[ / ]: move the current session's tab one place left or right; the ends do not wrap. */
export function moveSession(dir: 1 | -1) {
  const { nodes, order, session } = getState();
  const ids = roots(nodes, order).map((r) => r.id);
  const i = ids.indexOf(session ?? ''), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  saveOrder(ids);
}

/** One tab per session along the top; in the app it is the title bar, so empty space drags the window. */
export function SessionTabs() {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const renaming = useStore((s) => (s.renaming?.at === 'tab' ? s.renaming.id : null));
  const list = useMemo(() => sessions(nodes, order), [nodes, order]);
  const tabs = useRef<HTMLDivElement>(null);
  /** The current press became a drag, so the click that ends it does not select. */
  const dragged = useRef(false);
  const [menu, setMenu] = useState<{ id: string; at: DOMRect } | null>(null);
  /** Which edges hide tabs: ' fade-l', ' fade-r', both or neither. */
  const [fade, setFade] = useState('');
  const cur = list.find((s) => s.root.id === session);
  const menuRoot = menu ? nodes[menu.id] : undefined;

  const measure = () => {
    const el = tabs.current;
    if (el) setFade(`${el.scrollLeft > 0 ? ' fade-l' : ''}${el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? ' fade-r' : ''}`);
  };
  useEffect(() => {
    tabs.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [session, list.length]);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(tabs.current!);
    return () => observer.disconnect();
  }, []);

  // Neighbouring tabs slide aside while one is dragged; dropping saves the new order.
  const press = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const strip = tabs.current!;
    const all = Array.from(strip.querySelectorAll<HTMLElement>('.stab'));
    const from = all.indexOf(e.currentTarget), rects = all.map((t) => t.getBoundingClientRect());
    const ids = list.map((s) => s.root.id), x0 = e.clientX, width = rects[from].width;
    let to = from;
    const move = (ev: PointerEvent) => {
      const dx = Math.min(Math.max(ev.clientX - x0, rects[0].left - rects[from].left), rects.at(-1)!.right - rects[from].right);
      if (!dragged.current && Math.abs(ev.clientX - x0) < DRAG_START) return;
      dragged.current = true;
      strip.dataset.dragging = all[from].dataset.lifted = '';
      const mid = rects[from].left + width / 2 + dx;
      to = rects.filter((r, i) => i !== from && r.left + r.width / 2 < mid).length;
      all.forEach((t, i) => {
        const shift = i === from ? dx : i > from && i <= to ? -width : i < from && i >= to ? width : 0;
        t.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const end = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      if (!dragged.current) return;
      setTimeout(() => { dragged.current = false; }); // after the click this release causes, if any
      // Without the slide transition, so the tabs do not animate again once React reorders them.
      delete strip.dataset.dragging;
      delete all[from].dataset.lifted;
      for (const t of all) t.style.transform = '';
      if (ev.type === 'pointerup' && to !== from) { ids.splice(to, 0, ...ids.splice(from, 1)); saveOrder(ids); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  };

  return (
    // Tauri starts a drag only when the pressed element itself carries the attribute, so tabs and buttons never drag.
    <div className="dragstrip session-tabs" data-tauri-drag-region>
      <div className={`stabs${fade}`} role="group" aria-label="Sessions" ref={tabs} data-tauri-drag-region onScroll={measure}
        // A mouse wheel scrolls the strip sideways; a trackpad already does.
        onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1); }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.stab-main'));
          const i = buttons.indexOf((e.target as HTMLElement).closest('.stab')?.querySelector('.stab-main') as HTMLButtonElement);
          if (i < 0) return;
          e.preventDefault();
          buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
        }}>
        {list.map((s) => {
          const on = s === cur;
          const close = actionsFor(s.root).find((a) => a.key === 'close' || a.key === 'remove');
          return (
            <div key={s.root.id} className={`stab${on ? ' on' : ''}`}
              onPointerDown={renaming === s.root.id ? undefined : press}
              onClickCapture={(e) => { if (dragged.current) e.stopPropagation(); }}
              // Middle-click closes, as the x does: a live orchestrator still asks first.
              onAuxClick={(e) => { if (e.button === 1 && close && !s.root.changingHarness) close.run(); }}
              onContextMenu={(e) => { e.preventDefault(); if (!s.root.changingHarness) setMenu({ id: s.root.id, at: e.currentTarget.getBoundingClientRect() }); }}>
              {renaming === s.root.id ? (
                <span className="stab-main"><StateDot kind={s.kind} /><RenameInput id={s.root.id} title={s.root.title} /></span>
              ) : (
                <button className="stab-main" aria-current={on} title={s.root.title} onClick={() => selectSession(s.root.id)}
                  onDoubleClick={() => setRenaming({ id: s.root.id, at: 'tab' })}>
                  <StateDot kind={s.kind} /><span className="stab-title">{s.root.title}</span>
                </button>
              )}
              {close && (
                <button className="stab-close" title="Close session" aria-label={`Close session ${s.root.title}`} disabled={s.root.changingHarness} onClick={close.run}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className="stab-new" title="New session" aria-label="New session" onClick={() => openDialog({ kind: 'spawn', parentId: null, cwd: cur?.root.cwd ?? '' })}>
        <Icon name="plus" size={14} />
      </button>
      {menu && menuRoot && <ActionMenu label={`Actions for ${menuRoot.title}`} actions={actionsFor(menuRoot, 'tab')} at={menu.at} onClose={() => setMenu(null)} />}
    </div>
  );
}
