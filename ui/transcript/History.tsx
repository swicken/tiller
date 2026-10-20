import { useEffect, useState } from 'react';
import { fmtAge } from '../../src/shared/format';
import type { ArchivedNode, Outcome } from '../../src/shared/protocol';
import { fmtUsd } from '../../src/shared/spend';
import { OutcomeDetails } from '../controls/Bits';
import { send } from '../conn';
import { useNow } from '../hooks';
import { Icon } from '../controls/icons';
import { getState, openDialog, useStore, viewArchived } from '../store';
import { TranscriptPane } from './TranscriptPane';

const GLYPH = { succeeded: '✓', failed: '✗' } as const; // slop-ok: outcome marks, not emoji
const OutcomeGlyph = ({ o }: { o?: Outcome }) => (
  <span className={`glyph ${o?.outcome ?? 'none'}`} title={o ? o.outcome : 'no outcome reported'}>{o ? GLYPH[o.outcome] : '·'}</span>
);

/** "tl/n-123 merged into main", "tl/n-123 kept", "tl/n-123 discarded", or the bare branch when its fate is unknown. */
export const branchLine = (a: ArchivedNode) =>
  !a.branchFate ? a.branch : `${a.branch} ${a.branchFate === 'merged' && a.base ? `merged into ${a.base}` : a.branchFate}`;

/** Closed nodes of this tree or all trees, newest first, filtered by the daemon; picking one shows it in the main pane. */
export function HistoryPanel() {
  const items = useStore((s) => s.history);
  const session = useStore((s) => s.session);
  const shown = useStore((s) => s.archived?.id);
  const connected = useStore((s) => s.connected);
  const removals = useStore((s) => s.removals);
  const now = useNow();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const rootId = all ? undefined : session ?? undefined;
  const query = q.trim();

  // Debounced, so typing and a batch close (several removals) each ask once.
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => send({ t: 'history', ...(rootId && { rootId }), ...(query && { query }) }), 250);
    return () => clearTimeout(timer);
  }, [rootId, query, connected, removals]);

  return (
    <div className="history">
      <div className="hsearch">
        <input type="search" placeholder="Search closed nodes…" aria-label="Search closed nodes" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg" role="radiogroup" aria-label="Scope">
          <button role="radio" aria-checked={!all} className={all ? '' : 'on'} disabled={!session} onClick={() => setAll(false)}>This tree</button>
          <button role="radio" aria-checked={all} className={all ? 'on' : ''} onClick={() => setAll(true)}>All trees</button>
        </div>
      </div>
      <div className="hlist">
        {items.map((a) => {
          const line = a.brief ?? a.lastAssistantMessage;
          return (
            <button key={a.id} className={`arch${shown === a.id ? ' sel' : ''}`} aria-current={shown === a.id} onClick={() => viewArchived(a)}>
              <span className="l1">
                <OutcomeGlyph o={a.outcome} />
                <span className="title">{a.title}</span>
                <span className="age" title={`closed ${new Date(a.closedAt).toLocaleString()}`}>{fmtAge(now - a.closedAt)} ago</span>
              </span>
              {(a.branch || a.spentUsd !== undefined) && (
                <span className="meta">
                  {a.branch && <span className="part"><span className="branch" title={branchLine(a)}>⎇ {branchLine(a)}</span></span>}
                  {a.spentUsd !== undefined && <span className="part">{fmtUsd(a.spentUsd, a.spentIncomplete)}</span>}
                </span>
              )}
              {line && <span className="line">{line}</span>}
            </button>
          );
        })}
        {!items.length && <p className="hint">{query ? 'No closed nodes match.' : 'No closed nodes yet.'}</p>}
      </div>
    </div>
  );
}

/** A closed node's record and conversation, with Follow up and Fork. */
export function ArchivePane({ a }: { a: ArchivedNode }) {
  const now = useNow();
  const fork = () => openDialog({ kind: 'fork', from: a.id, title: a.title, cwd: a.cwd, parentId: a.parentId && getState().nodes[a.parentId] ? a.parentId : null });
  return (
    <TranscriptPane key={a.id} id={a.id} currentSessionId={a.sessionId} harness={a.harness}>
      <header className="archhead">
        <div className="tb1">
          <h1 title={a.title}>{a.title}</h1>
          <span className="tag" title={new Date(a.closedAt).toLocaleString()}>closed {fmtAge(now - a.closedAt)} ago</span>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog({ kind: 'followup', id: a.id, title: a.title })}><Icon name="play" size={14} />Follow up…</button>
          {(a.harness ?? 'claude') === 'claude' && <button className="btn" onClick={fork}><Icon name="fork" size={14} />Fork…</button>}
          <button className="btn icon" title="Close" aria-label="Close archived node" onClick={() => viewArchived(null)}><Icon name="x" size={14} /></button>
        </div>
        <div className="tb2">
          <span className="cwd" title={a.cwd}>{a.cwd}</span>
          {a.branch && <span className="tag">⎇ {branchLine(a)}</span>}
          {a.spentUsd !== undefined && <span>{fmtUsd(a.spentUsd, a.spentIncomplete)}</span>}
        </div>
        {a.brief && <p className="brief">{a.brief}</p>}
        {a.prompt && <details className="prompt"><summary>First prompt</summary><div>{a.prompt}</div></details>}
        {a.outcome && <OutcomeDetails o={a.outcome} />}
      </header>
    </TranscriptPane>
  );
}
