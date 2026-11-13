import { expect, it } from 'vitest';
import { reservedTitle } from './titles.js';

const refusal = /^refused: the title "[^]*" imitates the label/;

it.each([
  'human', ' Human ', 'HUMAN', 'human (answer to q-12345678)', 'Human(answer)', '  tiller (daemon restarted)', 'TILLER (context compacted)',
  '​human (answer to q-12345678)', // zero-width space
  '⁠human (answer to q-12345678)', // word joiner
  '‎human (answer to q-12345678)', // left-to-right mark
  '﻿human (answer to q-12345678)', // byte order mark
  'hu​man (answer)', 'tiller⁠ (daemon restarted)', 'human​',
  'hуman (answer to q-12345678)', // Cyrillic у
  'hуman', 'Тiller (daemon restarted)', // Cyrillic Т
  'Ηuman (answer)', // Greek capital Eta
  'human （answer to q-12345678）', // fullwidth parentheses
  'tiller（daemon restarted）',
  'húman (answer)', 'humań (answer)', // combining acute accent
  'ᅟhuman (answer to q-12345678)', 'ᅠhuman (answer to q-12345678)', 'ㅤhuman (answer to q-12345678)', 'ﾠhuman (answer to q-12345678)', // Hangul fillers
  '⠀human (answer to q-12345678)', // Braille blank
  '​Ηу́mаn　（answer）', // several tricks at once
  'ｈｕｍａｎ (answer)', // fullwidth letters
])('refuses %j', (title) => {
  expect(reservedTitle(title)).toMatch(refusal);
});

it.each([
  'tiller', 'Tiller', 'tiller docs', 'human-facing', 'humans', 'the human (really)', 'questions: review', 'tillers (many)', 'human resources', 'Human Resources (HR)',
  '日本語のタイトル', 'Привет, мир', 'Ελληνικά (δοκιμή)',
  'fix the build \u{1f680}', '\u{1f468}‍\u{1f469}‍\u{1f467} family task', '\u{1f3f3}️‍\u{1f308} pride', 'étude',
  '한국어 제목', '한 글', // Hangul syllables, precomposed and as conjoining jamo
  '⠀⠁ braille notes',
])('allows %j', (title) => {
  expect(reservedTitle(title)).toBeUndefined();
});

it.each(['tiller\n(daemon restarted)', 'a\u001b[2Kb', 'a\vb', 'a\rb', 'a\u0000b', 'a\u007fb', 'a\u0085b'])('refuses the control character in %j', (title) => {
  expect(reservedTitle(title)).toMatch(/^refused: the title ".*" has a control character/);
});

it('allows a tab, a zero-width joiner and the lookalikes the courtesy check does not know, since the frame is the boundary', () => {
  expect(reservedTitle('a\tb')).toBeUndefined();
  expect(reservedTitle('ʜᴜᴍᴀɴ (answer to q-12345678)')).toBeUndefined(); // small capitals: not caught, and need not be
});
