import { useEffect, useRef, useState } from 'react';
import type { Question } from '../../src/shared/protocol';
import { isOpen } from '../../src/shared/questions';
import { rootOf } from '../sidebar/sessions';
import { useStore } from '../store';
import { getDraft, isOwn, settleSent } from './drafts';
import { ended, notSent, ownerTitle } from './model';

/**
 * The module's one polite live region: a new open question, a question resolved elsewhere under text being typed, a refused
 * answer, and the outcome of this client's own answers and dismissals. It also drops the drafts of accepted answers, since only the daemon's reply says an answer was accepted.
 */
export function QuestionLive() {
  const questions = useStore((s) => s.questions);
  const nodes = useStore((s) => s.nodes);
  const refusals = useStore((s) => s.refusals);
  const snapshots = useStore((s) => s.snapshots);
  const before = useRef<{ questions: Record<string, Question>; snapshots: number; refusals: typeof refusals } | undefined>(undefined);
  const [said, setSaid] = useState({ n: 0, text: '' });
  useEffect(() => {
    const prev = before.current;
    before.current = { questions, snapshots, refusals };
    const lines = settleSent(questions, (q) => ownerTitle(q, nodes));
    // A snapshot replaces every question at once; only a lone question message is news.
    if (prev && prev.snapshots === snapshots) {
      for (const q of Object.values(questions)) {
        if (isOpen(q) && !prev.questions[q.id]) lines.push(`New question from ${q.askedBy.title} in ${nodes[rootOf(nodes, q.nodeId)]?.title ?? 'a closed session'}: ${q.question}`);
      }
    }
    // The card moves focus (to the kept text, its button, or its heading) when a question under someone's typing or focus is
    // resolved elsewhere, so say why. One this client's own answer settled was announced above, and a refusal says its own words.
    const focused = globalThis.document?.activeElement;
    for (const q of Object.values(questions)) {
      if (!prev?.questions[q.id] || !isOpen(prev.questions[q.id]) || isOpen(q) || isOwn(q) || prev.refusals[q.id] !== undefined || refusals[q.id] !== undefined) continue;
      const kept = !!getDraft(q.id).trim();
      if (kept || focused?.closest(`[aria-labelledby="${q.id}-h"]`)) lines.push(`${ended(q, nodes, false).filter(Boolean).join(' ')}${kept ? ' Your text is kept.' : ''}`);
    }
    // A refusal is said once, when it arrives; the card's notice is plain text so reopening the panel does not repeat it.
    for (const [id, message] of Object.entries(refusals)) {
      if (prev?.refusals[id] !== undefined || !questions[id]) continue;
      lines.push(notSent(questions[id], nodes, message).join(' '));
    }
    // A new element each time, so the same sentence twice in a row (two answers to one owner) is announced twice.
    if (lines.length) setSaid((s) => ({ n: s.n + 1, text: lines.join(' ') }));
  }, [questions, nodes, refusals, snapshots]);
  return <div className="sr-only" aria-live="polite" aria-atomic="true"><span key={said.n}>{said.text}</span></div>;
}
