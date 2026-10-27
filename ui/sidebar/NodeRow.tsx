import { ActionButtons } from '../controls/ActionButtons';
import { CtxBar, GateMark, outcomeLabel, StateDot } from '../controls/Bits';
import { hasChanges } from '../worktree';
import { fmtAge, shortEffort, shortModel } from '../../src/shared/format';
import { useNow } from '../hooks';
import { Icon } from '../controls/icons';
import { RenameInput } from '../controls/RenameInput';
import { selectNode, toggleCollapsed, useStore } from '../store';
import { isAgentKind, needsYou } from '../../src/shared/protocol';
import { kindTag, KIND_LABEL, statusKind, type Row } from './tree';

export function NodeRow({ row, tabStop }: { row: Row; tabStop?: boolean }) {
  const { node, depth, hasChildren, collapsed, descendants } = row;
  const now = useNow();
  const selected = useStore((s) => s.selected === node.id);
  const renaming = useStore((s) => s.renaming?.id === node.id && s.renaming.at === 'row');
  const s = node.status;
  const agent = isAgentKind(node.kind);
  const model = shortModel(s.model ?? node.model);
  const effort = s.effort ?? node.effort;
  const branch = node.worktree?.branch ?? s.git?.branch;
  const needs = descendants.filter((d) => needsYou(d.status)).length;
  const blocked = s.state === 'blocked' && !s.exited;
  const kind = statusKind(node);
  const state = kind === 'needs' ? s.state : KIND_LABEL[kind];
  const outcome = node.outcome && outcomeLabel(node.outcome);

  return (
    <div className={`row${selected ? ' sel' : ''}`} role="treeitem" aria-selected={selected} aria-level={depth + 1} aria-expanded={hasChildren ? !collapsed : undefined}
      title={`${node.title}${node.worktree ? ` · ${node.worktree.branch}` : ''}${s.model ?? node.model ? ` · ${s.model ?? node.model}` : ''}`}
      data-id={node.id} tabIndex={(tabStop ?? selected) ? 0 : -1}
      onFocus={(e) => { if (e.target === e.currentTarget && !selected) selectNode(node.id); }} onClick={() => selectNode(node.id)}>
      {row.guides.map((g, i) => <span key={i} className={`g${g ? ' v' : ''}`} />)}
      {depth > 0 && <span className={`g e${row.last ? '' : ' t'}`} />}
      <div className={`body${hasChildren && !collapsed ? ' expanded' : ''}`}>
        <div className="l1">
          {hasChildren ? (
            <button className={`caret${collapsed ? '' : ' open'}`} aria-label={collapsed ? 'Expand' : 'Collapse'}
              onClick={(e) => { e.stopPropagation(); toggleCollapsed(node.id); }}><Icon name="chevron" size={12} /></button>
          ) : <span className={`caret${depth > 0 ? ' stub' : ''}`} />}
          <StateDot kind={kind} />
          {renaming ? <RenameInput id={node.id} title={node.title} /> : <span className={`title${s.exited ? ' dim' : ''}`} title={node.title}>{node.title}</span>}
          {node.unread && <i className="unread" title="unread" />}
          {node.muted && <span className="muted" title="notifications muted"><Icon name="bellOff" size={11} /></span>}
          <span className="age" title="Time since last state change">{fmtAge(now - s.changedAt)}</span>
          <ActionButtons node={node} />
        </div>
        <div className="row-status">
          <span className={`row-state ${kind}`}>{node.kind === 'terminal' ? `terminal · ${state}` : state}</span>
          {s.activity && <span className={`row-activity${blocked ? ' warn' : ''}`} title={s.activity}>{s.activity}</span>}
        </div>
        {(node.gate || node.outcome || node.worktree?.missing || hasChanges(node) || collapsed || (s.stalled && !s.exited)) && <div className="row-signals">
          {node.outcome && <span role="note" className={`count${node.outcome.outcome === 'failed' ? ' bad' : ''}`}
            aria-label={`Reported task outcome: ${outcome}`}
            title={`Reported task outcome: ${outcome}${node.outcome.summary ?? node.outcome.note ? ` · ${node.outcome.summary ?? node.outcome.note}` : ''}`}>
            {node.outcome.outcome === 'failed' ? outcome : `outcome ${outcome}`}</span>}
          {node.worktree?.missing && <span className="count warn" title="The worktree directory is gone; resume is refused">worktree missing</span>}
          {node.gate && <GateMark gate={node.gate} />}
          {hasChanges(node) && <span className="count" title={`unmerged work on ${node.status.git!.branch}: merge or close it`}>changes · {node.status.git!.ahead} ahead · {node.status.git!.dirty} dirty</span>}
          {collapsed && <span className="count" title={`${descendants.length} hidden`}>+{descendants.length}</span>}
          {collapsed && descendants.some((d) => d.unread) && <span className="count" title="Hidden nodes have unread activity">unread</span>}
          {collapsed && descendants.some((d) => d.status.stalled && !d.status.exited) && <span className="count warn">stalled below</span>}
          {collapsed && needs > 0 && <span className="count warn">{needs} needs you</span>}
          {s.stalled && !s.exited && <span className="count warn" title="working with no hook event">no activity {fmtAge(now - s.changedAt)}</span>}
        </div>}
        {agent && <div className="row-meta">
          <span className="row-model" title={`${kindTag(node)}${s.model ?? node.model ? ` · ${s.model ?? node.model}` : ''}`}>{model || kindTag(node)}</span>
          {effort && <span className="row-effort" title={`Reasoning effort: ${effort}`}>{shortEffort(effort)}</span>}
          {s.contextPct !== undefined && <CtxBar pct={s.contextPct} />}
        </div>}
        {branch && <div className="row-workspace" title={`Branch: ${branch}`}>{branch}</div>}
      </div>
    </div>
  );
}
