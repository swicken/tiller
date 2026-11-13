import { useEffect, useRef, useState } from 'react';
import type { Question } from '../../src/shared/protocol';
import { isOpen } from '../../src/shared/questions';
import { rootOf } from '../sidebar/sessions';
import { useStore } from '../store';
import { settleSent } from './drafts';
import { notSent, ownerTitle } from './model';

/**
 * The module's one polite live region: a new open question, a refused answer, and the outcome of this client's own answers
 * and dismissals. It also drops the drafts of accepted answers, since only the daemon's reply says an answer was accepted.
 */
export function QuestionLive() {
  const questions = useStore((s) => s.questions);
  const nodes = useStore((s) => s.nodes);
  const refusals = useStore((s) => s.refusals);
  const before = useRef<{ questions: Record<string, Question>; nodes: typeof nodes; refusals: typeof refusals } | undefined>(undefined);
  const [said, setSaid] = useState({ n: 0, text: '' });
  useEffect(() => {
    const prev = before.current;
    before.current = { questions, nodes, refusals };
    const lines = settleSent(questions, (q) => ownerTitle(q, nodes));
    // A snapshot replaces nodes and questions together; only a lone question message is news.
    if (prev && prev.nodes === nodes) {
      for (const q of Object.values(questions)) {
        if (isOpen(q) && !prev.questions[q.id]) lines.push(`New question from ${q.askedBy.title} in ${nodes[rootOf(nodes, q.nodeId)]?.title ?? 'a closed session'}: ${q.question}`);
      }
    }
    // A refusal is said once, when it arrives; the card's notice is plain text so reopening the panel does not repeat it.
    for (const [id, message] of Object.entries(refusals)) {
      if (prev?.refusals[id] !== undefined || !questions[id]) continue;
      lines.push(notSent(questions[id], nodes, message).join(' '));
    }
    // A new element each time, so the same sentence twice in a row (two answers to one owner) is announced twice.
    if (lines.length) setSaid((s) => ({ n: s.n + 1, text: lines.join(' ') }));
  }, [questions, nodes, refusals]);
  return <div className="sr-only" aria-live="polite" aria-atomic="true"><span key={said.n}>{said.text}</span></div>;
}
