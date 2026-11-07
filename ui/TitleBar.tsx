import { isAgentKind, type NodeView } from '../src/shared/protocol';
import { ActionButtons } from './controls/ActionButtons';
import { NodeMeta, StateDot } from './controls/Bits';
import { Icon } from './controls/icons';
import { RenameInput } from './controls/RenameInput';
import { ancestry } from './sidebar/sessions';
import { selectNode, showPane, togglePanel, useStore } from './store';
import { DORMANT_TITLE, kindTag, statusKind, statusLabel } from './sidebar/tree';

function Breadcrumb({ node }: { node: NodeView }) {
  const nodes = useStore((s) => s.nodes);
  const renaming = useStore((s) => s.renaming?.id === node.id && s.renaming.at === 'title');
  const chain = ancestry(nodes, node.id);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {chain.slice(0, -1).map((n) => (
        <span key={n.id} className="crumb-wrap">
          <button className="crumb" onClick={() => selectNode(n.id)}>{n.title}</button>
          <Icon name="chevron" size={12} />
        </span>
      ))}
      {renaming ? <RenameInput id={node.id} title={node.title} /> : <h1 title={node.title}>{node.title}</h1>}
    </nav>
  );
}

export function TitleBar({ node }: { node: NodeView }) {
  const panel = useStore((s) => s.panel);
  const agent = isAgentKind(node.kind);
  const diff = useStore((s) => s.diffOpen) && !!node.worktree;
  const transcript = useStore((s) => s.transcriptOpen) && agent;
  const shell = useStore((s) => s.shellOpen) && agent;
  // A terminal node's own PTY is its Terminal; an agent node's Terminal tab is the human's shell beside it.
  const tabs = [
    { key: 'agent', label: agent ? 'Agent' : 'Terminal', on: !diff && !transcript && !shell, show: true },
    { key: 'diff', label: 'Diff', on: diff, show: !!node.worktree },
    { key: 'transcript', label: 'Transcript', on: transcript, show: agent },
    { key: 'shell', label: 'Terminal', on: shell, show: agent },
  ] as const;
  const kind = statusKind(node);
  const s = node.status;
  return (
    <header className="titlebar" key={node.id}>
      <div className="tb1">
        <Breadcrumb node={node} />
        <span className={`badge ${kind}`} title={s.exited && node.dormant ? DORMANT_TITLE : undefined}><StateDot kind={kind} />{statusLabel(node)}{s.errored && s.interrupted ? ' (interrupted)' : ''}</span>
        <span className="spacer" />
        <ActionButtons node={node} labels />
      </div>
      <div className="tb2">
        <span className="cwd" title={node.cwd}>{node.cwd}</span>
        <span className="tag">{kindTag(node)}</span>
        {s.permissionMode && s.permissionMode !== 'default' && <span className="tag">{s.permissionMode}</span>}
        <NodeMeta node={node} detail />
      </div>
      <div className="tb-views">
        {tabs.filter((t) => t.show).length > 1 && (
          <div className="pane-tabs" role="group" aria-label="Pane">
            {tabs.filter((t) => t.show).map((t) => (
              <button key={t.key} className={t.on ? 'on' : ''} aria-pressed={t.on} onClick={() => showPane(t.key)}>
                {t.key === 'shell' && node.suggestion ? <>{t.label}<i className="unread tab-dot" title="Suggested command waiting" /></> : t.label}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <button className={`btn panel-toggle${panel ? ' on' : ''}`} title="Last response" aria-label="Toggle last response panel" aria-pressed={panel} onClick={togglePanel}>
          <Icon name="panel" size={14} /><span>Last response</span>
        </button>
      </div>
    </header>
  );
}
