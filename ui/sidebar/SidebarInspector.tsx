import { useLayoutEffect, useRef, useState } from 'react';
import { isAgentKind, PROFILE_LABELS, profileFor, type NodeView } from '../../src/shared/protocol';
import { fmtTokens, shortModel } from '../../src/shared/format';
import { CtxBar, DiffCounts, outcomeLabel, StateDot } from '../controls/Bits';
import { Icon } from '../controls/icons';
import { accountMismatch, KIND_LABEL, kindTag, statusKind } from './tree';
import { readPreference, useResizeHandle } from './useResizeHandle';
import './sidebar-inspector.css';

const HEIGHT = { key: 'tl.sidebarInspectorHeight', initial: 300, min: 160, max: 560 };

/** Reserve 120px for the tree; in short windows share the remaining space. */
export function inspectorBounds(available: number) {
  const space = Math.max(0, available);
  const max = Math.floor(Math.min(HEIGHT.max, space - Math.min(120, space * 0.45)));
  return { min: Math.min(HEIGHT.min, max), max };
}

export function inspectorHeight(preferred: number, available: number) {
  const { min, max } = inspectorBounds(available);
  return Math.round(Math.max(min, Math.min(max, preferred)));
}

export const readInspectorHeight = () => readPreference(HEIGHT);

export function SidebarInspector({ node, onClose }: { node: NodeView | null; onClose: () => void }) {
  const root = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(() => typeof window === 'undefined' ? 600 : window.innerHeight);

  useLayoutEffect(() => {
    const parent = root.current?.closest<HTMLElement>('.sidebar-session-body');
    if (!parent) return;
    const measure = () => {
      const bodyHeight = Math.min(parent.clientHeight, window.innerHeight - parent.getBoundingClientRect().top);
      setAvailable(Math.max(0, bodyHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const { size: height, props } = useResizeHandle(HEIGHT, inspectorBounds(available), (preferred) => inspectorHeight(preferred, available), 'y');

  const s = node?.status;
  const git = s?.git;
  const agent = node && isAgentKind(node.kind);
  const kind = node && statusKind(node);
  const row = (label: string, value: React.ReactNode) => <div className="inspector-fact"><dt>{label}</dt><dd>{value}</dd></div>;

  return <section id="sidebar-inspector" ref={root} aria-label="Selected node details" style={{ height }}>
    <div {...props} className="inspector-resize" aria-label="Details height" aria-controls="sidebar-inspector-content"
      title="Drag to resize details. Up/Down resize; Home/End set minimum/maximum. Double-click to reset." />
    <div id="sidebar-inspector-content" className="inspector-content">
      <header className="inspector-header">
        <h2>{node?.title || 'Node details'}</h2>
        <button className="inspector-close" onClick={onClose} aria-label="Close details" title="Close details"><Icon name="x" size={16} /></button>
      </header>
      {!node || !s || !kind ? <p className="inspector-empty">Select a node in this session to see its details.</p> : <>
        <dl className="inspector-facts">
          {row('Live status', <span className={`inspector-state ${kind}`}><StateDot kind={kind} />{KIND_LABEL[kind]}</span>)}
          {row('Harness', kindTag(node))}
          {agent && (node.account || node.repoAccount !== undefined) && row('Account', node.repoAccount !== undefined
            ? <span className="warn">{accountMismatch(node)}</span>
            : node.account)}
          {agent && row('Role', node.role ?? (node.parentId ? 'worker' : 'orchestrator'))}
          {agent && row('Profile', PROFILE_LABELS[profileFor(node.profile, node.parentId, node.role)])}
          {agent && row('Model', shortModel(s.model ?? node.model) || 'Not reported')}
          {agent && row('Effort', s.effort ?? node.effort ?? 'Not reported')}
        </dl>
        {(node.unread || s.errored || s.interrupted || s.stale || s.stalled || node.pending?.blocked) && <p className="inspector-attention">
          {[node.unread && 'Unread message', s.errored && 'Turn errored', s.interrupted && 'Interrupted', s.stale && 'Stale status', s.stalled && 'Activity stalled', node.pending?.blocked].filter(Boolean).join(' · ')}
        </p>}
        <h3>Activity</h3>
        <p className="inspector-text">{s.activity || 'No activity reported.'}</p>
        {s.lastAssistantMessage && <details><summary>Last assistant message</summary><p className="inspector-text">{s.lastAssistantMessage}</p></details>}
        <h3>Workspace</h3>
        <dl className="inspector-facts">
          {row('Directory', <span className="inspector-path">{node.cwd}</span>)}
          {row('Branch', <span className="inspector-path">{node.worktree?.branch ?? git?.branch ?? 'Not reported'}</span>)}
          {node.worktree && row('Base', <span className="inspector-path">{node.worktree.base}</span>)}
          {node.worktree?.missing && row('Worktree', <span className="warn">Missing — resume unavailable</span>)}
          {git && <>
            {row('Commits', `${git.ahead} ahead · ${git.behind} behind ${git.base}`)}
            {row('Changes', <>{git.dirty} uncommitted file{git.dirty === 1 ? '' : 's'} · <DiffCounts git={git} /></>)}
            {git.mergedAt && row('Merge', `Merged into ${git.base}`)}
            {git.conflicts && row('Conflicts', <span className="warn">Merging {git.base} conflicts in {git.conflicts.join(', ')}</span>)}
          </>}
        </dl>
        {agent && <><h3>Context</h3><p>{s.contextPct !== undefined ? <CtxBar pct={s.contextPct} /> : 'Not reported'}
          {s.contextTokens !== undefined && s.contextWindow !== undefined && <span className="inspector-tokens">{fmtTokens(s.contextTokens)} / {fmtTokens(s.contextWindow)} tokens</span>}
        </p></>}
        <h3>Completion</h3>
        <dl className="inspector-facts">
          {row('Reported outcome', node.outcome ? <span title="Reported task outcome">{outcomeLabel(node.outcome)}</span> : 'Not reported')}
          {row('Completion gate', node.gate ?? node.outcome?.gate ?? 'Not reported')}
        </dl>
        {node.outcome?.summary && <p className="inspector-text">{node.outcome.summary}</p>}
        {node.outcome?.note && <p className="inspector-text">{node.outcome.note}</p>}
      </>}
    </div>
  </section>;
}
