import { useEffect, useMemo, useRef, useState } from 'react';
import { send } from '../conn';
import { HistoryPanel } from '../transcript/History';
import { Icon } from '../controls/icons';
import { NodeRow } from './NodeRow';
import { SessionSwitcher } from './SessionSwitcher';
import { SidebarInspector } from './SidebarInspector';
import { SidebarResize } from './SidebarResize';
import { flattenSession, type Row } from './tree';
import { selectNode, toggleCollapsed, toggleHistory, useStore, viewMemory } from '../store';
import { readPref, writePref } from '../prefs';

const DETAILS_KEY = 'tl.sidebarDetails';
export const readSidebarDetails = () => readPref(DETAILS_KEY) !== '0';
export const saveSidebarDetails = (open: boolean) => writePref(DETAILS_KEY, open ? '1' : '0');

export function useRows(): Row[] {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const collapsed = useStore((s) => s.collapsed);
  return useMemo(() => (session ? flattenSession(nodes, order, session, collapsed) : []), [nodes, order, session, collapsed]);
}

/** j/k (or arrows) move the selection, h/l collapse and expand. Only reached when focus is in the sidebar. */
function onKey(e: React.KeyboardEvent, rows: Row[], selected: string | null) {
  if ((e.target as HTMLElement).closest('button, input, textarea, select, a, [role="menu"], [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const i = rows.findIndex((r) => r.node.id === selected);
  const row = rows[i];
  const go = (j: number) => {
    const r = rows[Math.min(rows.length - 1, Math.max(0, j))];
    if (!r) return;
    e.preventDefault();
    selectNode(r.node.id);
    Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')).find((el) => el.dataset.id === r.node.id)?.focus();
  };
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectNode(row.node.id); }
  else if (e.key === 'j' || e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'k' || e.key === 'ArrowUp') go(i - 1);
  else if (row && (e.key === 'h' || e.key === 'ArrowLeft') && row.hasChildren && !row.collapsed) { e.preventDefault(); toggleCollapsed(row.node.id); }
  else if (row && (e.key === 'l' || e.key === 'ArrowRight') && row.collapsed) { e.preventDefault(); toggleCollapsed(row.node.id); }
}

export function Sidebar({ onSettings }: { onSettings: () => void }) {
  const rows = useRows();
  const selected = useStore((s) => s.selected);
  const exited = useStore((s) => Object.values(s.nodes).filter((n) => n.status.exited).length);
  const node = useStore((s) => s.selected ? s.nodes[s.selected] ?? null : null);
  const [detailsOpen, setDetailsOpen] = useState(readSidebarDetails);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const restoreDetailsFocus = useRef(false);
  const changeDetails = (open: boolean) => { setDetailsOpen(open); saveSidebarDetails(open); };
  const tree = useRef<HTMLDivElement>(null);
  const tabStop = rows.some((r) => r.node.id === selected) ? selected : rows[0]?.node.id;
  const history = useStore((s) => s.historyOpen);
  const panelOpen = useStore((s) => s.panel);
  const memory = useStore((s) => !!s.memoryView);

  useEffect(() => {
    if (restoreDetailsFocus.current) {
      const target = detailsOpen ? tree.current?.parentElement?.querySelector<HTMLElement>('.inspector-resize') : detailsButton.current;
      target?.focus();
      restoreDetailsFocus.current = false;
    }
  }, [detailsOpen]);

  // Keep keyboard focus aligned with selection, including global Cmd+number shortcuts.
  // Nested controls and portalled menus retain their own focus.
  useEffect(() => {
    const row = tree.current?.querySelector<HTMLElement>('.row.sel');
    row?.scrollIntoView({ block: 'nearest' });
    const active = document.activeElement;
    if (tree.current && (active === tree.current || (active?.getAttribute('role') === 'treeitem' && tree.current.contains(active)))) row?.focus();
  }, [selected]);

  return (
    <aside className="sidebar">
      <SessionSwitcher />
      {history ? <HistoryPanel /> : (
        <div className="sidebar-session-body">
          <div className="tree" role="tree" aria-label="Session nodes" tabIndex={rows.length ? -1 : 0} ref={tree} onKeyDown={(e) => onKey(e, rows, selected)}>
            {rows.map((r) => <NodeRow key={r.node.id} row={r} tabStop={r.node.id === tabStop} />)}
            {!rows.length && <p className="hint">Choose New session to start an agent or terminal.</p>}
          </div>
          {detailsOpen ? <SidebarInspector node={node} onClose={() => { restoreDetailsFocus.current = true; changeDetails(false); }} /> :
            <button ref={detailsButton} className="details-reopen" aria-expanded={false} aria-controls="sidebar-inspector"
              onClick={() => { restoreDetailsFocus.current = true; changeDetails(true); }}><Icon name="chevron" size={12} />Show details</button>}
        </div>
      )}
      <footer className="sidefoot">
        <button className="btn" onClick={onSettings}>Settings</button>
        <button className="btn" disabled={!exited} onClick={() => send({ t: 'prune' })} title="Remove exited nodes that have no live descendant">
          <Icon name="trash" size={14} />Clear exited{exited ? ` (${exited})` : ''}
        </button>
        <button className={`btn hist${history ? ' on' : ''}`} aria-pressed={history} onClick={toggleHistory} title="History: closed nodes to read, follow up or fork" aria-label="History">
          <Icon name="history" size={14} />History
        </button>
        <button className={`btn mem${memory ? ' on' : ''}`} aria-pressed={memory} aria-label="Memory" title="Memory: what Tiller remembers for the selected node's repository, or any account and repository"
          onClick={() => viewMemory(memory ? null : selected ? { nodeId: selected } : {})}><Icon name="memory" size={14} /></button>
      </footer>
      <SidebarResize panelOpen={panelOpen} />
    </aside>
  );
}
