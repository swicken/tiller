import { expect, it } from 'vitest';
import { reservedTitle } from './titles.js';

it.each(['human', ' Human ', 'HUMAN', 'human (answer to q-12345678)', 'Human(answer)', '  tiller (daemon restarted)', 'TILLER (context compacted)', 'tiller\n(daemon restarted)'])('refuses %j', (title) => {
  expect(reservedTitle(title)).toMatch(/^refused: the title "[^]*" imitates the label/);
});

it.each(['tiller', 'Tiller', 'tiller docs', 'human-facing', 'humans', 'the human (really)', 'questions: review', 'tillers (many)'])('allows %j', (title) => {
  expect(reservedTitle(title)).toBeUndefined();
});
