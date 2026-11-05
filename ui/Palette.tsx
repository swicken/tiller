import { useMemo, useState } from 'react';
import { dndActive, harnessFor, isAgentKind, shellStreamId, type NodeView } from '../src/shared/protocol';
import { StateDot } from './controls/Bits';
import { cwdBase } from './format';
import { Modal } from './controls/Modal';
import { ancestry } from './sidebar/sessions';
import { activityUnread, openDialog, selectNode, setActivityOpen, showPane, toggleHistory, useStore, type Dialog } from './store';
import { getTerm } from './terminals';
import { toggleDnd, useNow } from './hooks';
import { send } from './conn';
import { statusKind } from './sidebar/tree';

export function Palette() {
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const all = useMemo(() => order.map((id) => nodes[id]).filter(Boolean).map((n) => {
    const root = ancestry(nodes, n.id)[0] ?? n;
    return { n, where: root === n ? cwdBase(n.cwd) : `${root.title} · ${cwdBase(n.cwd)}` };
  }), [nodes, order]);
  const cur = useStore((s) => (s.selected ? s.nodes[s.selected] : undefined));
  const historyOpen = useStore((s) => s.historyOpen);
  const unread = useStore((s) => activityUnread(s.activity));
  const dnd = useStore((s) => s.dnd);
  const quiet = dndActive(dnd, useNow());
  const needle = q.toLowerCase();
  const close = () => openDialog(null);
  const replace = (dialog: Dialog) => { close(); requestAnimationFrame(() => openDialog(dialog)); };
  const nodeHits = all.filter((h) => `${h.n.title} ${h.where}`.toLowerCase().includes(needle))
    .map((h) => ({ key: h.n.id, title: h.n.title, sub: h.where, n: h.n, run: () => { selectNode(h.n.id); close(); } }));
  // Commands follow the nodes; each opens its own view or dialog in place of the palette.
  const cmds = [
    { key: 'cmd:activity', title: 'Activity', sub: `recent agent events${unread ? ` · ${unread} unread` : ''}`, run: () => { close(); requestAnimationFrame(() => setActivityOpen(true)); } },
    { key: 'cmd:dnd', title: quiet ? 'Turn off do not disturb' : 'Do not disturb for 1 hour', sub: 'toggle OS notifications', run: () => { toggleDnd(); close(); } },
    { key: 'cmd:updates', title: 'Manage updates…', sub: 'available releases and installation', run: () => replace({ kind: 'update' }) },
    { key: 'cmd:check-updates', title: 'Check for updates', sub: 'check releases and open update management', run: () => { send({ t: 'updateCheck' }); replace({ kind: 'update' }); } },
    { key: 'cmd:history', title: historyOpen ? 'Hide history' : 'History', sub: 'closed nodes: read, follow up or fork', run: () => { toggleHistory(); close(); } },
    // Pane switches, so the keyboard alone reaches a node's shell. Focus after the palette has closed and handed focus back.
    // Selecting the node first leaves a historical node's view, which would otherwise stay over both panes.
    ...(cur && isAgentKind(cur.kind) ? [
      { key: 'cmd:shell', title: `Terminal: ${cur.title}`, sub: `your shell in ${cwdBase(cur.cwd)}${cur.suggestion ? ' · suggested command waiting' : ''}`, run: () => { selectNode(cur.id); showPane('shell'); close(); requestAnimationFrame(() => getTerm(shellStreamId(cur.id))?.term.focus()); } },
      { key: 'cmd:agent', title: `Agent: ${cur.title}`, sub: "the agent's terminal", run: () => { selectNode(cur.id); showPane('agent'); close(); requestAnimationFrame(() => getTerm(cur.id)?.term.focus()); } },
    ] : []),
    ...(cur && isAgentKind(cur.kind) && harnessFor(cur) === 'claude' ? [{ key: 'cmd:fork', title: `Fork ${cur.title}…`, sub: 'new node from its conversation', run: () => openDialog({ kind: 'fork', from: cur.id, title: cur.title, cwd: cur.cwd, parentId: cur.parentId }) }] : []),
  ].filter((c) => `${c.title} ${c.sub}`.toLowerCase().includes(needle));
  const hits: Array<{ key: string; title: string; sub: string; n?: NodeView; run: () => void }> = [...nodeHits, ...cmds];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && hits[i]) hits[i].run();
  };
  return (
    <Modal label="Command palette" className="palette" onClose={close}>
      <input autoFocus placeholder="Jump to a node or run a command…" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={onKey} />
      <div className="hits">
        {hits.map((h, j) => (
          <div key={h.key} className={`hit${j === i ? ' active' : ''}`} onMouseMove={() => setI(j)} onClick={h.run}>
            {h.n ? <StateDot kind={statusKind(h.n)} /> : <span className="dot cmd" />}<span className="st">{h.title}</span><span className="sc">{h.sub}</span>
          </div>
        ))}
        {!hits.length && <p className="hint">No matches.</p>}
      </div>
    </Modal>
  );
}
