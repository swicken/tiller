import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { harnessFor, isAgentKind, type NodeView } from '../../src/shared/protocol';
import { canMerge } from '../worktree';
import { send } from '../conn';
import { Icon, type IconName } from './icons';
import { openDialog, setRenaming, type Renaming } from '../store';

interface Act { key: string; label: string; icon: IconName; run: () => void; danger?: boolean }

export function actionsFor(node: NodeView, renameAt: Renaming['at'] = 'row'): Act[] {
  const exited = !!node.status.exited;
  const root = node.parentId === null;
  const remove: Act = { key: 'remove', label: root ? 'Close' : 'Remove', icon: 'trash', danger: true,
    run: () => node.worktree ? openDialog({ kind: 'kill', id: node.id }) : send({ t: 'close', id: node.id, ...(root ? { force: true } : {}) }) };
  // A live orchestrator is never killed outright: Close asks first, and Restart stays the usual way to clear one.
  const closeLive: Act = { key: 'close', label: 'Close', icon: 'trash', danger: true, run: () => openDialog({ kind: 'kill', id: node.id }) };
  const last: Act = root
    ? { key: 'restart', label: 'Restart', icon: 'restart', run: () => openDialog({ kind: 'restart', id: node.id }) }
    : exited
      ? remove
      : { key: 'kill', label: 'Kill', icon: 'x', danger: true, run: () => openDialog({ kind: 'kill', id: node.id }) };
  return [
    ...(!exited ? [{ key: 'child', label: 'New child', icon: 'subnode' as const, run: () => openDialog({ kind: 'spawn', parentId: node.id, cwd: node.cwd }) }] : []),
    { key: 'rename', label: 'Rename', icon: 'edit', run: () => setRenaming({ id: node.id, at: renameAt }) },
    node.muted
      ? { key: 'mute', label: 'Unmute notifications', icon: 'bell', run: () => send({ t: 'mute', id: node.id, muted: false }) }
      : { key: 'mute', label: 'Mute notifications', icon: 'bellOff', run: () => send({ t: 'mute', id: node.id, muted: true }) },
    ...(isAgentKind(node.kind) && harnessFor(node) === 'claude' ? [{ key: 'fork', label: 'Fork…', icon: 'fork' as const, run: () => openDialog({ kind: 'fork', from: node.id, title: node.title, cwd: node.cwd, parentId: node.parentId }) }] : []),
    ...(isAgentKind(node.kind) && !node.pending && node.gate !== 'running' ? [{ key: 'harness', label: 'Change harness…', icon: 'restart' as const, run: () => openDialog({ kind: 'changeHarness', id: node.id }) }] : []),
    ...(exited && isAgentKind(node.kind) ? [{ key: 'resume', label: 'Resume', icon: 'play' as const, run: () => send({ t: 'resume', id: node.id }) }] : []),
    ...(canMerge(node) ? [{ key: 'merge', label: `Merge into ${node.status.git!.base}`, icon: 'merge' as const, run: () => send({ t: 'merge', id: node.id }) }] : []),
    ...(root ? [exited ? remove : closeLive] : []),
    last,
  ];
}

/** Fixed portal coordinates use the visible viewport, which excludes scrollbars. */
export function actionMenuPosition(rect: Pick<DOMRect, 'top' | 'bottom' | 'right'>, width: number, height: number, menuWidth: number): CSSProperties {
  const fittedWidth = Math.min(menuWidth, Math.max(0, width - 16));
  const above = height - rect.bottom < 260 && rect.top > height / 2;
  return {
    left: Math.max(8, Math.min(rect.right - fittedWidth, width - fittedWidth - 8)),
    maxWidth: Math.max(0, width - 16),
    ...(above ? { bottom: height - rect.top + 6 } : { top: rect.bottom + 6 }),
    maxHeight: Math.max(0, (above ? rect.top : height - rect.bottom) - 14),
  };
}

/**
 * Node actions in a portal menu below `at`, with arrow-key focus; a click elsewhere (outside `trigger`), Escape, a
 * resize or a scroll closes it. `onClose(true)` asks for focus back where the menu came from.
 */
export function ActionMenu({ id, label, actions, at, focusLast, trigger, onClose }: {
  id?: string; label: string; actions: Act[]; at: Pick<DOMRect, 'top' | 'bottom' | 'right'>; focusLast?: boolean;
  trigger?: RefObject<HTMLElement | null>; onClose: (restoreFocus?: boolean) => void;
}) {
  const [position, setPosition] = useState<CSSProperties>({});
  const menu = useRef<HTMLDivElement>(null);

  // Placed once, when it opens: `at` is where its opener was then.
  useLayoutEffect(() => {
    setPosition(actionMenuPosition(at, document.documentElement.clientWidth, document.documentElement.clientHeight, menu.current!.getBoundingClientRect().width));
  }, []);
  useEffect(() => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[focusLast ? items.length - 1 : 0]?.focus();
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger?.current?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); }
    };
    const moved = (e: Event) => { if (!menu.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', moved);
    window.addEventListener('scroll', moved, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', moved);
      window.removeEventListener('scroll', moved, true);
    };
  }, []);

  return createPortal(
    <div ref={menu} id={id} className="node-action-menu" role="menu" aria-label={label} style={position}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey) { onClose(); return; }
        if (e.altKey) return;
        e.stopPropagation();
        const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        } else if (e.key === 'Tab') {
          // Return to the trigger before the native Tab step leaves this action group.
          onClose(true);
        }
      }}>
      {actions.map((a) => (
        <button key={a.key} role="menuitem" tabIndex={-1} className={a.danger ? 'danger' : ''} onClick={() => { onClose(true); a.run(); }}>
          <Icon name={a.icon} size={14} /><span>{a.label}</span>
        </button>
      ))}
    </div>, document.body,
  );
}

/** Header actions with labels; compact row actions without them. */
export function ActionButtons({ node, labels }: { node: NodeView; labels?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const focusLast = useRef(false);
  const actions = actionsFor(node, labels ? 'title' : 'row');
  const primary = actions.filter((a) => a.key === 'merge' || (labels && a.key === 'child'));
  const secondary = actions.filter((a) => !primary.includes(a));

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const reveal = (last = false) => {
    setOpen(true);
    // Focus after React has mounted the menu, for pointer and keyboard users alike.
    focusLast.current = last;
  };

  useEffect(() => { setOpen(false); }, [node.id]);

  return (
    <span className={`actions node-actions${labels ? ' labelled' : ''}`} onClick={(e) => e.stopPropagation()}>
      {primary.map((a) => (
        <button key={a.key} className={`btn ${labels && a.key === 'child' ? 'primary' : 'icon'} node-action-${a.key}`} title={a.label} aria-label={a.label} disabled={node.changingHarness} onClick={a.run}>
          <Icon name={a.icon} size={14} />{labels && <span>{a.label}</span>}
        </button>
      ))}
      <button ref={trigger} className="btn icon node-action-more" title="More actions" aria-label={`More actions for ${node.title}`} disabled={node.changingHarness} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => open ? close() : reveal()}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'j', 'k', 'h', 'l', 'Enter', ' '].includes(e.key)) e.stopPropagation();
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); reveal(e.key === 'ArrowUp'); }
        }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && <ActionMenu id={menuId} label={`Actions for ${node.title}`} actions={secondary} at={trigger.current!.getBoundingClientRect()}
        focusLast={focusLast.current} trigger={trigger} onClose={close} />}
    </span>
  );
}
