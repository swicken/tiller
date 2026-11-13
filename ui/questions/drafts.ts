import type { Question } from '../../src/shared/protocol';

// Text typed into a question's box, per question id. Module-level so it survives closing the panel and switching cards.
const drafts = new Map<string, string>();
export const getDraft = (id: string) => drafts.get(id) ?? '';
export const setDraft = (id: string, text: string) => void (text ? drafts.set(id, text) : drafts.delete(id));
export const clearDraft = (id: string) => void drafts.delete(id);
export function moveDraft(from: string, to: string) {
  setDraft(to, getDraft(from));
  drafts.delete(from);
}

/** What this client last sent for a question, until the daemon's reply shows whether it was accepted. */
interface Sent { choice?: string; text?: string; dismiss?: boolean }
const sent = new Map<string, Sent>();
export const noteSent = (id: string, s: Sent) => void sent.set(id, s);
export const forgetSent = (id: string) => void sent.delete(id);

/** True when the question changed because of what this client sent: its answer was accepted, or its dismissal. */
export function isOwn(q: Question): boolean {
  const s = sent.get(q.id);
  if (!s) return false;
  return s.dismiss ? q.state === 'dismissed' : q.state === 'answered' && q.answer?.choice === s.choice && q.answer?.text === s.text;
}

/** Drops the drafts of accepted answers and dismissals, and returns what to announce for each. */
export function settleSent(questions: Record<string, Question>, ownerOf: (q: Question) => string): string[] {
  const lines: string[] = [];
  for (const id of [...sent.keys()]) {
    const q = questions[id];
    if (!q || !isOwn(q)) continue;
    lines.push(sent.get(id)!.dismiss ? `Dismissed. ${ownerOf(q)} wasn’t told.` : `Answer sent to ${ownerOf(q)}.`);
    clearDraft(id);
    forgetSent(id);
  }
  return lines;
}
