import type { NodeView } from '../src/shared/protocol';
import { branchLabel } from '../src/shared/format';
import { actionsFor } from './controls/ActionButtons';
import { DiffCounts, OutcomeDetails } from './controls/Bits';
import { Icon } from './controls/icons';

const CARD = ['resume', 'merge', 'restart', 'remove'];

/** Sits over the last screen of an exited node. */
export function ExitedCard({ node }: { node: NodeView }) {
  return (
    <div className="exited-overlay" role="alertdialog" aria-label={`${node.title} has exited`}>
      <div className="card">
        <h2>{node.title} has exited</h2>
        <p>The process is no longer running. Resume continues the session where it left off.</p>
        {node.status.errored && node.status.activity && <p>{node.status.activity}</p>}
        {node.status.git && <p className="branchline">⎇ {branchLabel(node.status.git)} <DiffCounts git={node.status.git} /></p>}
        {node.outcome && <OutcomeDetails o={node.outcome} />}
        <div className="btns">
          {actionsFor(node).filter((a) => CARD.includes(a.key)).map((a) => (
            <button key={a.key} className={`btn${a.key === 'resume' ? ' primary' : a.danger ? ' danger' : ''}`} autoFocus={a.key === 'resume'} onClick={a.run}>
              <Icon name={a.icon} size={14} />{a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
