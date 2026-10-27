import { useEffect, useMemo, useRef } from 'react';
import { actionsFor } from './controls/ActionButtons';
import { StateDot } from './controls/Bits';
import { Icon } from './controls/icons';
import { sessions } from './sidebar/sessions';
import { getState, openDialog, selectSession, useStore } from './store';

/** Cmd+Shift+[ / ]: select the previous or next session tab, wrapping around. */
export function stepSession(dir: 1 | -1) {
  const { nodes, order, session } = getState();
  const list = sessions(nodes, order);
  if (!list.length) return;
  const i = list.findIndex((s) => s.root.id === session);
  const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  selectSession(list[next].root.id);
}

/** Cmd+Shift+1..9: select the Nth session tab, if there is one. */
export function nthSession(n: number): boolean {
  const { nodes, order } = getState();
  const s = sessions(nodes, order)[n - 1];
  if (s) selectSession(s.root.id);
  return !!s;
}

/** One tab per session along the top; in the app it is the title bar, so empty space drags the window. */
export function SessionTabs() {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const list = useMemo(() => sessions(nodes, order), [nodes, order]);
  const tabs = useRef<HTMLDivElement>(null);
  const cur = list.find((s) => s.root.id === session);

  useEffect(() => {
    tabs.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [session, list.length]);

  return (
    // Tauri starts a drag only when the pressed element itself carries the attribute, so tabs and buttons never drag.
    <div className="dragstrip session-tabs" data-tauri-drag-region>
      <div className="stabs" role="group" aria-label="Sessions" ref={tabs} data-tauri-drag-region onKeyDown={(e) => {
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
            <div key={s.root.id} className={`stab${on ? ' on' : ''}`}>
              <button className="stab-main" aria-current={on} title={s.root.title} onClick={() => selectSession(s.root.id)}>
                <StateDot kind={s.kind} /><span className="stab-title">{s.root.title}</span>
              </button>
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
    </div>
  );
}
