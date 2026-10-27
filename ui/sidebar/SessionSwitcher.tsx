import { useEffect, useMemo, useRef, useState } from 'react';
import { StateDot } from '../controls/Bits';
import { cwdBase } from '../format';
import { Icon } from '../controls/icons';
import { RenameInput } from '../controls/RenameInput';
import { openDialog, selectSession, setRenaming, useStore } from '../store';
import { sessions } from './sessions';

export function SessionSwitcher() {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  const list = useMemo(() => sessions(nodes, order), [nodes, order]);
  const cur = list.find((s) => s.root.id === session);
  const others = list.filter((s) => s !== cur && s.needs > 0).reduce((a, s) => a + s.needs, 0);
  const renaming = useStore((s) => s.renaming?.at === 'session' && s.renaming.id === cur?.root.id);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const rename = () => { setOpen(false); if (cur) setRenaming({ id: cur.root.id, at: 'session' }); };

  const wasRenaming = useRef(false);

  // Enter and Escape remove the editor and drop focus to the body; return it to the pencil.
  useEffect(() => {
    if (wasRenaming.current && !renaming && document.activeElement === document.body) pencil.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    addEventListener('mousedown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="switcher" ref={box} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      {renaming && cur ? (
        <div className="session-select renaming"><StateDot kind={cur.kind} /><RenameInput id={cur.root.id} title={cur.root.title} /></div>
      ) : (
        <div className="session-select" onContextMenu={(e) => { if (cur) { e.preventDefault(); rename(); } }}>
          <button className="current" ref={trigger} aria-label={`Switch session: ${cur?.root.title ?? 'No session'}`}
            aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'session-menu' : undefined}
            onMouseDown={(e) => { if (open && e.button === 0) e.preventDefault(); }}
            onClick={() => open ? close() : setOpen(true)} onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}>
            {cur ? <><StateDot kind={cur.kind} /><span className="session-copy"><span className="st">{cur.root.title}</span><span className="sc" title={cur.root.cwd}>{cwdBase(cur.root.cwd)}</span></span></> : <span className="sc">No session</span>}
            {(cur?.needs ?? 0) > 0 && <span className="count warn" title="needs you in this session">{cur!.needs}</span>}
            {others > 0 && <span className="count warn" title="needs you in other sessions">+{others}</span>}
            {cur && <span className="rename-slot" />}
            <Icon name="updown" size={14} />
          </button>
          {/* A sibling of the selector, not nested in it; it sits over the selector's rename slot. */}
          {cur && <button ref={pencil} className="session-rename" title="Rename session" aria-label="Rename session" onClick={rename}><Icon name="edit" size={14} /></button>}
        </div>
      )}
      <div className="session-controls">
        <button className="btn new-session" onClick={() => { setOpen(false); openDialog({ kind: 'spawn', parentId: null, cwd: cur?.root.cwd ?? '' }); }}>
          <Icon name="plus" size={14} />New session
        </button>
      </div>
      {open && (
        <div className="menu" id="session-menu" role="menu" aria-label="Sessions" ref={menu} onKeyDown={(e) => {
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
          const i = buttons.indexOf(e.target as HTMLButtonElement);
          const last = buttons.length - 1;
          let next: number;
          if (e.key === 'ArrowDown') next = i === last ? 0 : i + 1;
          else if (e.key === 'ArrowUp') next = i <= 0 ? last : i - 1;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = last;
          else return;
          e.preventDefault(); buttons[next]?.focus();
        }}>
          {list.map((s) => (
            <button key={s.root.id} className={`sess${s === cur ? ' cur' : ''}`} role="menuitemradio" aria-checked={s === cur}
              // WebKit blurs without focusing clicked buttons; keep the menu mounted until click.
              onMouseDown={(e) => { if (e.button === 0) e.preventDefault(); }}
              onClick={() => { selectSession(s.root.id); close(); }}>
              <StateDot kind={s.kind} />
              <span className="session-copy"><span className="st">{s.root.title}</span><span className="sc" title={s.root.cwd}>{cwdBase(s.root.cwd)}</span></span>
              {s.needs > 0 && <span className="count warn" title="needs you">{s.needs}</span>}
            </button>
          ))}
          {!list.length && <p className="hint">No sessions yet.</p>}
        </div>
      )}
    </div>
  );
}
