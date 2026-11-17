import { useMemo } from 'react';
import { closeNeeds, openNeeds, useStore } from '../store';
import { reminderList, sentence } from './model';

/**
 * The one-line reminder of the session on screen's first open question. Rendered twice: in the pane-tab row and as a bar over
 * the stage; the container query in questions.css shows one of them, so neither moves the terminal.
 */
export function QuestionReminder({ bar }: { bar?: boolean }) {
  const questions = useStore((s) => s.questions);
  const nodes = useStore((s) => s.nodes);
  const session = useStore((s) => s.session);
  const selected = useStore((s) => s.selected);
  const needs = useStore((s) => s.needs);
  const list = useMemo(() => reminderList(questions, nodes, session, selected), [questions, nodes, session, selected]);
  const q = list[0];
  if (!q) return null;
  // The asker, even after the question moved to an agent above it: that agent did not ask.
  const asker = q.askedBy.title;
  const waiting = !q.assumption;
  const more = list.length - 1;
  return (
    <button className={`q-remind${waiting ? '' : ' carrying'}${bar ? ' q-bar' : ''}`} aria-haspopup="dialog" aria-expanded={needs.open} aria-controls="qpanel"
      aria-label={`Answer ${asker}’s question: ${more ? `${sentence(q.question)} ${more} more in this session` : q.question}`} title={`${asker} asks: ${q.question}`}
      onClick={() => (needs.open && needs.focusId === q.id ? closeNeeds() : openNeeds(q.id))}>
      {waiting ? <span className="dot needs" /> : <span className="qring" />}
      <span className="q-who">{asker} asks</span>
      <span className="q-text">{q.question}</span>
      {!waiting && <span className="q-carry">· carrying on</span>}
      {more > 0 && <span className="q-more">+{more} more</span>}
      <span className="q-go">Answer</span>
    </button>
  );
}
