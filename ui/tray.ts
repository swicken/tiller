import { needsYou, type NodeView, type Question } from '../src/shared/protocol';
import { isOpen, sortQuestions } from '../src/shared/questions';
import { statusKind } from './sidebar/tree';

/**
 * The app's menu bar item: red if a node errored, amber if one needs you or a question is open, else green; and what
 * needs you, as [node id, text]: nodes blocked on a prompt, then open questions. items.length is what `attention` counts.
 */
export function trayState(nodes: NodeView[], questions: Question[]): { color: 'green' | 'amber' | 'red'; items: [string, string][] } {
  const needs = nodes.filter((n) => needsYou(n.status));
  const items: [string, string][] = [
    ...needs.map((n): [string, string] => [n.id, n.title]),
    ...sortQuestions(questions.filter(isOpen)).map((q): [string, string] => [q.nodeId, `${nodes.find((n) => n.id === q.nodeId)?.title ?? q.nodeId}: ${q.question}`]),
  ];
  const color = nodes.some((n) => statusKind(n) === 'errored') ? 'red' : items.length ? 'amber' : 'green';
  return { color, items };
}
