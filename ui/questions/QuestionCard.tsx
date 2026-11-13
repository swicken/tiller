import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Question } from '../../src/shared/protocol';
import { isOpen } from '../../src/shared/questions';
import { send } from '../conn';
import { Icon, type IconName } from '../controls/icons';
import { useNow } from '../hooks';
import { clearRefusal, openNeeds, useStore } from '../store';
import type { Nodes } from '../sidebar/tree';
import { clearDraft, forgetSent, getDraft, isOwn, moveDraft, noteSent, setDraft } from './drafts';
import { ago, ownerTitle, withdrawnBy } from './model';

const answerText = (q: Question) => [q.answer?.choice, q.answer?.text].filter(Boolean).join('\n');

/** [bold lead, sentence] for a question that is no longer open. `refused`: the sentence for an answer that arrived too late. */
function ended(q: Question, nodes: Nodes, refused: boolean): [string, string] {
  const asker = q.askedBy.title;
  if (q.replacedBy) return refused ? ['Not sent.', `${asker} replaced this with a newer question.`] : ['Replaced by a newer question.', `${asker} asked again.`];
  if (q.state === 'dismissed') return refused ? ['Not sent.', 'This was already dismissed.'] : ['You dismissed this.', `${asker} wasn’t told.`];
  if (q.state === 'withdrawn') {
    const { who, name } = withdrawnBy(q, nodes);
    const lead = refused ? 'Not sent.' : 'No longer needed.';
    if (who === 'tiller') return [lead, 'The agent that asked was closed, with no agent above it.'];
    const tail = refused ? 'this just before your answer arrived' : 'it';
    const reason = q.withdrawn?.reason ? `: “${q.withdrawn.reason}”` : '';
    return [lead, `${who === 'asker' ? name : `${name}, the agent above it,`} withdrew ${tail}${reason}.`];
  }
  return refused ? ['Not sent.', `This was already answered, in another window or from the shell: “${answerText(q).replace('\n', ' · ')}”.`] : ['', 'This was answered in another window while you were writing.'];
}

function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);
  return <button className={`btn${primary ? ' primary' : ''}`} onClick={() => { navigator.clipboard.writeText(text).then(() => setDone(true), () => {}); }}>{done ? 'Copied' : label}</button>;
}

const Lead = ({ lead, children }: { lead: string; children?: ReactNode }) => <>{lead && <b>{lead}</b>} {children}</>;

interface Props {
  q: Question;
  /** Move focus into the card when it appears: the panel opened on it, or the person chose it. */
  focus: boolean;
  /** Select a node; the full-window panel closes first. */
  go: (nodeId: string) => void;
  /** The question "Next question" opens, when another one is waiting. */
  next?: string;
}

/** A question as a card: open (answer it), resolved (what happened to it), or with its refused or orphaned text kept. */
export function QuestionCard({ q, focus, go, next }: Props) {
  const nodes = useStore((s) => s.nodes);
  const questions = useStore((s) => s.questions);
  const refusal = useStore((s) => s.refusals[q.id]);
  const connected = useStore((s) => s.connected);
  const now = useNow();
  const [text, setText] = useState(() => getDraft(q.id));
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const first = useRef(true);

  const open = isOpen(q);
  const owner = ownerTitle(q, nodes);
  const asker = q.askedBy.title;
  const waiting = !q.assumption;
  // The module's draft is the truth: it is cleared when this client's answer is accepted, which no render sees.
  const draft = getDraft(q.id);
  const kept = !!refusal || (!open && !isOwn(q) && !!draft.trim());
  const form = kept ? 'kept' : open ? 'open' : 'resolved';
  const sending = busy && open && !refusal;
  const blocked = !connected || sending;
  const ownerStopped = !!nodes[q.nodeId]?.status.exited;
  const goId = nodes[q.askedBy.id] ? q.askedBy.id : nodes[q.nodeId] ? q.nodeId : undefined;
  const replacement = q.replacedBy && questions[q.replacedBy] && isOpen(questions[q.replacedBy]) ? q.replacedBy : undefined;

  useEffect(() => { if (refusal || !connected) setBusy(false); }, [refusal, connected]);
  // Focus goes where the person needs it next (design 7); after the first render only when the focused control has just gone.
  useEffect(() => {
    const a = document.activeElement;
    const lost = !a || a === document.body || !!card.current?.contains(a);
    const want = first.current ? focus : lost;
    first.current = false;
    if (!want) return;
    const target = form === 'kept' ? card.current?.querySelector<HTMLElement>('.qcard-foot .primary') : form === 'open' && !(q.choices && !text) ? input.current : head.current;
    target?.focus();
  }, [form]);

  const edit = (v: string) => { setText(v); setDraft(q.id, v); };
  const answer = (choice?: string) => {
    const t = text.trim();
    if (blocked || (!choice && !t)) return;
    noteSent(q.id, { choice, text: t || undefined });
    setBusy(true);
    send({ t: 'question', id: q.id, action: 'answer', ...(choice ? { choice } : {}), ...(t ? { text: t } : {}) });
  };
  const dismiss = () => {
    if (blocked) return;
    noteSent(q.id, { dismiss: true });
    setBusy(true);
    send({ t: 'question', id: q.id, action: 'dismiss' });
  };
  const discard = () => { clearDraft(q.id); forgetSent(q.id); clearRefusal(q.id); setText(''); };
  const moveText = () => { moveDraft(q.id, replacement!); clearRefusal(q.id); openNeeds(replacement); };

  const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const verb = q.replacedBy ? 'replaced' : q.state === 'open' ? '' : q.state;
  const when = form === 'resolved' ? `${verb} ${ago(now - (q.resolvedAt ?? q.askedAt))}` : ago(now - q.askedAt);
  const heading = <h3 className={`qcard-q${form === 'open' && q.question.length > 140 ? ' long' : ''}`} id={`${q.id}-h`} tabIndex={-1} ref={head}>{q.question}</h3>;
  const meta = (
    <div className="qcard-meta">Asked by{' '}
      {nodes[q.askedBy.id]
        ? <button className="q-owner" title={`Go to ${asker}`} onClick={() => go(q.askedBy.id)}><span>{asker}</span><Icon name="chevron" size={12} /></button>
        : <><span className="q-gone">{asker}</span> (closed)</>}
      {' · '}<time title={`Asked at ${stamp(q.askedAt)} · ${q.id}`}>{when}</time>
    </div>
  );
  const goButton = (id: string, primary?: boolean) => <button className={`btn${primary ? ' primary' : ''}`} onClick={() => go(id)}>Go to {nodes[id]?.title}</button>;
  const frame = (cls: string, body: ReactNode) => <article className={`qcard ${cls}`} aria-labelledby={`${q.id}-h`} ref={card}>{heading}{meta}{body}</article>;

  if (form === 'kept') {
    const [lead, rest] = open ? ['Not sent.', refusal ?? ''] : ended(q, nodes, !!refusal);
    const second = !draft ? '' : replacement ? 'Your text is kept below; you can move it to the new question.' : refusal && q.state === 'answered' ? 'Your text is kept below so you can copy it.' : 'Your text is kept below.';
    const withdrawn = q.state === 'withdrawn' && !q.replacedBy && goId;
    return frame('resolved', <>
      <div className="q-refused" role="alert"><Icon name="alert" size={14} /><div><p><Lead lead={lead}>{rest}</Lead></p>{second && <p>{second}</p>}</div></div>
      {draft && <textarea className="q-input" readOnly rows={3} aria-label="Your text, not sent" value={draft} />}
      <div className="qcard-foot">
        <button className="q-quiet" onClick={discard}>{draft ? 'Discard text' : 'OK'}</button>
        <span className="spacer" />
        {draft && !replacement && <CopyButton text={draft} label="Copy text" primary={!withdrawn} />}
        {draft && replacement && <button className="btn primary" onClick={moveText}>Move text to the new question</button>}
        {draft && withdrawn && goButton(goId, true)}
      </div>
    </>);
  }

  if (form === 'resolved') {
    const [lead, rest] = ended(q, nodes, false);
    const status = (cls: string, icon: IconName, body: ReactNode, button?: ReactNode) => (
      <p className={`qoutcome ${cls}`} role="status"><Icon name={icon} size={13} /><span>{body}{button && <span className="btns-inline">{button}</span>}</span></p>
    );
    if (q.state !== 'answered') {
      return frame('resolved', status('', 'info', <Lead lead={lead}>{rest}</Lead>,
        replacement && <button className="btn" onClick={() => openNeeds(replacement)}>Show the new question</button>));
    }
    const d = q.delivery;
    const goOwner = <button className="btn" onClick={() => go(q.nodeId)}>Go to {owner}</button>;
    return frame('resolved', <>
      <div className="q-answer"><span className="q-answer-label">You answered</span>
        {q.answer?.choice && <span className="q-answer-choice">{q.answer.choice}</span>}
        {q.answer?.text && <p className="q-answer-text">{q.answer.text}</p>}</div>
      <div title={d?.state === 'waiting' ? d.detail : undefined}>
        {d?.state === 'queued' ? status('', 'history', <><b>Waiting until {owner} is free.</b> It will read your answer when it finishes its current turn.</>)
          : d?.state === 'delivered' ? status('delivered', 'check', <><b>Delivered to {owner}</b> · {ago(now - (d.at ?? q.answer?.at ?? now))}</>)
          : d?.state === 'unconfirmed' ? status('unconfirmed', 'alert', <><b>It may not have seen this.</b> The answer was sent but not confirmed; {owner} can still look it up.</>, goOwner)
          : d?.state === 'dropped' ? status('dropped', 'x', <><b>Couldn’t be delivered.</b> The agent that asked was closed, and no agent is left to receive it.</>, <CopyButton text={answerText(q)} label="Copy answer" />)
          : d?.state === 'waiting' ? (ownerStopped
            ? status('', 'history', <><b>Not sent yet.</b> {owner} isn’t running; it will get your answer when it starts again.</>, goOwner)
            : status('', 'history', <><b>Not sent yet.</b> Tiller will keep trying.</>))
          : null}
      </div>
      {next && <div className="qcard-next"><button className="btn" onClick={() => openNeeds(next)}>Next question</button></div>}
    </>);
  }

  const moved = q.nodeId !== q.askedBy.id;
  return frame(waiting ? '' : 'carrying', <>
    {waiting
      ? <p className="qcard-state"><span className="qpill waiting">Waiting on you</span><span>Its work is on hold until you answer.</span></p>
      : <p className="qcard-state"><span className="qpill carrying">Carrying on</span><span className="q-meanwhile">Meanwhile: {q.assumption}</span></p>}
    {ownerStopped && <div className="qnote"><Icon name="info" size={13} /><div><b>{owner} isn’t running.</b> You can still answer; it gets your answer when it starts again.<div><button className="btn" onClick={() => go(q.nodeId)}>Go to {owner}</button></div></div></div>}
    {moved && <div className="qnote"><Icon name="info" size={13} /><div><b>{asker} has closed,</b> so your answer will go to {owner}, the agent above it.</div></div>}
    {q.context && <details className="qcard-ctx"><summary><Icon name="chevron" size={12} />Background</summary><div className="qcard-ctx-body">{q.context}</div></details>}
    {q.choices && <div className="qcard-choices" role="group" aria-label="Answer with a choice">
      {q.choices.map((c) => <button key={c} className="q-choice" disabled={blocked} onClick={() => answer(c)}>{c}</button>)}
    </div>}
    <textarea className="q-input" ref={input} rows={text ? 3 : 2} aria-label={`Your answer to ${owner}`} value={text} onChange={(e) => edit(e.target.value)}
      placeholder={q.choices ? 'Add a note, or write your own answer' : 'Write your answer'}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); answer(); } }} />
    {text && q.choices && <p className="qcard-hint">A choice sends this note with it.</p>}
    {!connected && <p className="qcard-hint">Tiller isn’t connected right now. Your text is kept.</p>}
    <div className="qcard-foot">
      <button className="q-quiet" disabled={blocked} onClick={dismiss}
        title={`Remove it from your list. The agent is not told${waiting ? ', so it keeps waiting' : ''}.`}>Dismiss</button>
      <span className="spacer" /><span className="q-hint">⌘↵</span>
      <button className="btn primary" aria-keyshortcuts="Meta+Enter" disabled={blocked || !text.trim()} aria-disabled={blocked || !text.trim()}
        title={text.trim() ? undefined : 'Write an answer first, or pick a choice'} onClick={() => answer()}>{sending ? 'Sending…' : 'Send'}</button>
    </div>
  </>);
}
