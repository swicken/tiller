import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isOpen, sortQuestions } from '../../src/shared/questions';
import { Icon } from '../controls/icons';
import { useNow } from '../hooks';
import { closeNeeds, openNeeds, selectNode, useStore } from '../store';
import { listing, questionsIn, type Group } from './model';
import { QuestionCard } from './QuestionCard';
import { ApprovalRow, QuestionRow } from './QuestionRow';

/** Below this main-column width the panel is a full-window modal dialog (design 3.3). */
const MODAL_BELOW = 480;
const mainWidth = () => document.querySelector('.main')?.clientWidth ?? Infinity;

const waitingIn = (g: Group) => g.items.filter((i) => i.kind === 'approval' || isOpen(i.q)).length;
const heading = (g: Group, cls: string, count?: number) => (
  <h3 className={cls}><b>{g.title}</b>{g.note && <span>· {g.note}</span>}{count !== undefined && <span className="qgroup-n">{count}</span>}</h3>
);

function OpenPanel() {
  const questions = useStore((s) => s.questions);
  const nodes = useStore((s) => s.nodes);
  const order = useStore((s) => s.order);
  const session = useStore((s) => s.session);
  const focusId = useStore((s) => s.needs.focusId);
  const now = useNow();
  const [modal, setModal] = useState(() => mainWidth() < MODAL_BELOW);
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  const previousFocus = useRef(document.activeElement);

  // Every question seen open since the panel opened keeps its place; a new one joins the end (design 6).
  const pinned = useRef<string[]>([]);
  for (const q of sortQuestions(Object.values(questions))) if (isOpen(q) && !pinned.current.includes(q.id)) pinned.current.push(q.id);
  const list = listing(questions, nodes, order, session, pinned.current, now);
  const shown = questionsIn(list.groups);
  const firstOpen = shown.find(isOpen)?.id;
  // Fixed when the panel opens: a question that arrives later is a closed row, and never takes focus from wherever the person is typing.
  const [opening] = useState(firstOpen);
  const cardId = focusId ?? opening;

  // The store holds which card is open, so "Next question" is the only thing that ever advances it.
  useEffect(() => {
    if (!focusId && firstOpen) openNeeds(firstOpen);
    else if (!cardId) { // nothing to answer: start on the first approval row, or on the panel itself
      const root = panel.current ?? dialog.current;
      (root?.querySelector<HTMLElement>('.qrow') ?? root)?.focus();
    }
  }, []);
  useLayoutEffect(() => {
    const el = document.querySelector('.main');
    if (!el) return;
    const watch = new ResizeObserver(() => setModal(el.clientWidth < MODAL_BELOW));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => { if (el?.open) el.close(); };
  }, [modal]);
  useLayoutEffect(() => () => {
    const p = previousFocus.current;
    if (p instanceof HTMLElement && p !== document.body && p.isConnected && !document.querySelector('dialog[open]')) p.focus();
  }, []);

  const go = (id: string) => { selectNode(id); if (modal) closeNeeds(); };
  const nextAfter = (id: string) => {
    const at = shown.findIndex((q) => q.id === id);
    return [...shown.slice(at + 1), ...shown].find((q) => q.id !== id && isOpen(q))?.id;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !modal) { e.preventDefault(); closeNeeds(); return; }
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('.qrow, .qcard-q')];
    const at = stops.indexOf(e.target as HTMLElement);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && at >= 0) {
      e.preventDefault();
      stops[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  };

  const cards = (groups: Group[]) => groups.map((g) => (
    <Fragment key={g.key}>
      {heading(g, 'qgroup qsub')}
      <ul className="qlist">{g.items.map((i) => i.kind === 'q' && <li key={i.q.id}><QuestionCard q={i.q} focus={false} go={go} /></li>)}</ul>
    </Fragment>
  ));
  const section = (title: string, groups: Group[], open: boolean) => {
    const n = groups.reduce((t, g) => t + g.items.length, 0);
    return n > 0 && <details className="qsection" open={open}><summary><Icon name="chevron" size={12} /><b>{title}</b> ({n})</summary>{cards(groups)}</details>;
  };

  const content = (
    <>
      <header className="qpanel-head">
        <h2 id="qpanel-h">Needs you</h2>
        <span className="qpanel-count">{list.waiting ? `${list.waiting} waiting` : 'Nothing waiting'}</span>
        <span className="spacer" />
        <button className="btn" title="Close (Esc)" onClick={closeNeeds}>Close</button>
      </header>
      <div className="qpanel-body">
        {!list.waiting && (
          <div className="qempty">
            <h3>Nothing needs you right now</h3>
            <p>When an agent asks you something, or stops to wait for your approval, it appears here and stays until you deal with it.</p>
          </div>
        )}
        {list.groups.map((g) => (
          <Fragment key={g.key}>
            {heading(g, 'qgroup', waitingIn(g))}
            <ul className="qlist">
              {g.items.map((i) => i.kind === 'approval'
                ? <li key={`a:${i.node.id}`}><ApprovalRow node={i.node} go={go} /></li>
                : <li key={i.q.id}>{i.q.id === cardId || !isOpen(i.q)
                  ? <QuestionCard q={i.q} focus={i.q.id === cardId} go={go} next={nextAfter(i.q.id)} />
                  : <QuestionRow q={i.q} />}</li>)}
            </ul>
          </Fragment>
        ))}
        {section('Not delivered', list.notDelivered, true)}
        {section('Done in the last day', list.done, false)}
      </div>
    </>
  );
  return modal
    ? <dialog ref={dialog} className="qpanel qpanel-modal" id="qpanel" aria-labelledby="qpanel-h" onCancel={(e) => { e.preventDefault(); closeNeeds(); }} onClose={(e) => { if (e.currentTarget.isConnected) closeNeeds(); }} onKeyDown={onKeyDown}>{content}</dialog>
    : <section ref={panel} className="qpanel" id="qpanel" role="dialog" aria-labelledby="qpanel-h" tabIndex={-1} onKeyDown={onKeyDown}>{content}</section>;
}

/** The Needs you panel over the top right of the stage; a full-window dialog when the main column is narrow. */
export function NeedsPanel() {
  return useStore((s) => s.needs.open) ? <OpenPanel /> : null;
}
