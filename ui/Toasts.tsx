import { useEffect } from 'react';
import { send } from './conn';
import { Modal } from './controls/Modal';
import type { DigestItem } from '../src/shared/protocol';
import { fmtAge } from '../src/shared/format';
import { rootOf } from './sidebar/sessions';
import { dismissDigest, dismissToast, dropConfirm, openNeeds, selectNode, useStore, type Toast } from './store';

function ToastItem({ t }: { t: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(t.id), 6000);
    return () => clearTimeout(timer);
  }, [t.id]);
  const nodes = useStore((s) => s.nodes);
  const onScreen = useStore((s) => s.session);
  if (t.questionId) {
    const owner = (t.nodeId && nodes[t.nodeId]?.title) || 'An agent', root = t.nodeId ? rootOf(nodes, t.nodeId) : undefined;
    return (
      <button className={`toast ${t.tone} qtoast`} aria-label={`Answer ${owner}’s question`} onClick={() => { openNeeds(t.questionId); dismissToast(t.id); }}>
        <span className="q-toast-who">{owner} asks{root && root !== onScreen && <span> · in {nodes[root]?.title}</span>}</span>
        <span className="q-toast-q">{t.text}</span>
      </button>
    );
  }
  return (
    <div className={`toast ${t.tone}`} role="status" onClick={() => { if (t.nodeId) selectNode(t.nodeId); dismissToast(t.id); }}>{t.text}</div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts">{toasts.map((t) => <ToastItem key={t.id} t={t} />)}</div>;
}

/** An agent asks the human to approve an action. Must be answered; the daemon closes it on timeout. */
export function ConfirmModal() {
  const queue = useStore((s) => s.confirms);
  const c = queue[0];
  if (!c) return null;
  const answer = (ok: boolean) => { send({ t: 'confirm', confirmId: c.confirmId, ok }); dropConfirm(c.confirmId); };
  return (
    <Modal title={queue.length > 1 ? `Agent request (1 of ${queue.length})` : 'Agent request'}>
      <pre className="ask">{c.text}</pre>
      <div className="btns">
        <button className="btn danger" onClick={() => answer(false)}>Deny</button>
        <button className="btn primary" onClick={() => answer(true)}>Approve</button>
      </div>
    </Modal>
  );
}

const DIGEST_LABEL = { needsYou: 'Needs you', errored: 'Errored', finished: 'Finished' } as const;

/** One away-digest row. A question row reads "Asked you" and opens the Needs you panel on its question; the others select their node. */
function DigestRow({ i }: { i: DigestItem }) {
  const q = useStore((s) => (i.questionId ? s.questions[i.questionId] : undefined));
  // The daemon words a question's digest text "Asks: <question>"; the row already says "Asked you".
  const text = i.questionId ? (q?.question ?? i.text?.replace(/^Asks: /, '')) : i.text;
  return (
    <li>
      <button className={`row ${i.kind}`} onClick={() => { if (i.questionId) openNeeds(i.questionId); else selectNode(i.id); dismissDigest(); }}>
        <span className="kind">{i.questionId ? 'Asked you' : DIGEST_LABEL[i.kind]}</span> <strong>{i.title}</strong>
        {q && <span className={`kind q-kind-state${q.assumption ? '' : ' waiting'}`}> · {q.assumption ? 'carrying on meanwhile' : 'waiting on you'}</span>}
        {text && <span className="text">{text}</span>}
      </button>
    </li>
  );
}

/** What happened while you were away, needs-you first. Waits behind agent requests. */
export function DigestCard() {
  const digest = useStore((s) => s.digest);
  const blocked = useStore((s) => s.confirms.length > 0);
  if (!digest || blocked) return null;
  return (
    <Modal title={`While you were away (${fmtAge(Date.now() - digest.since)})`} onClose={dismissDigest}>
      <ul className="digest">{digest.items.map((i) => <DigestRow key={i.id + (i.questionId ?? '')} i={i} />)}</ul>
      <div className="btns"><button className="btn primary" autoFocus onClick={dismissDigest}>Dismiss</button></div>
    </Modal>
  );
}
