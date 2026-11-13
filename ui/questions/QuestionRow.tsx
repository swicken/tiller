import type { NodeView, Question } from '../../src/shared/protocol';
import { Icon } from '../controls/icons';
import { useNow } from '../hooks';
import { openNeeds, useStore } from '../store';
import { ago, ownerTitle, shortAge } from './model';

/** A question that is not the open card: two lines of it, who it waits on, and its age. Activating it opens the card. */
export function QuestionRow({ q }: { q: Question }) {
  const nodes = useStore((s) => s.nodes);
  const now = useNow();
  const owner = ownerTitle(q, nodes);
  const who = q.nodeId !== q.askedBy.id ? `${owner} (from ${q.askedBy.title}, closed)` : owner;
  const stopped = nodes[q.nodeId]?.status.exited;
  return (
    <button className="qrow" aria-expanded="false" onClick={() => openNeeds(q.id)}>
      {q.assumption ? <span className="qring" /> : <span className="dot needs" />}
      <span className="qrow-main">
        <span className="qrow-q">{q.question}</span>
        <span className="qrow-sub">
          {q.assumption
            ? <><span className="qstate carrying">Carrying on</span> · {who} · Meanwhile: {q.assumption}</>
            : <><span className="qstate waiting">Waiting on you</span> · {who}{stopped ? ' · isn’t running' : ''}</>}
        </span>
      </span>
      <time title={`Asked at ${new Date(q.askedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${q.id}`}>{shortAge(now - q.askedAt)}</time>
    </button>
  );
}

/** A node blocked on a prompt in its own terminal, or on Claude's own question tool. It never expands; it goes to the node. */
export function ApprovalRow({ node, go }: { node: NodeView; go: (id: string) => void }) {
  const now = useNow();
  return (
    <button className="qrow approval" title={`Open ${node.title} to respond in its terminal`} onClick={() => go(node.id)}>
      <span className="dot needs" />
      <span className="qrow-main">
        <span className="qrow-q"><b>{node.title}</b> {node.status.state === 'waiting' ? 'asked something in its window' : 'needs your approval'} · {ago(now - node.status.changedAt)}</span>
        {node.status.activity && <span className="qrow-sub">{node.status.activity}</span>}
      </span>
      <span className="q-open">Open<Icon name="chevron" size={12} /></span>
    </button>
  );
}
