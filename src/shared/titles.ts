/**
 * Lookalikes of the letters h u m a n t i l e r that compatibility normalization does not fold. This is a courtesy
 * list for the common Cyrillic and Greek letters, not all of Unicode's confusables, and it is not meant to grow. Capitals
 * are listed too, because lowercasing would send Greek capital Η (looks like H) and lowercase η (looks like n) to the same letter.
 */
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  ['һh', 'Һh', 'Нh', 'Ηh', 'уu', 'υu', 'мm', 'Мm', 'μm', 'Μm', 'аa', 'Аa', 'αa', 'Αa', 'нn', 'ηn', 'Νn', 'тt', 'Тt', 'τt', 'Τt', 'іi', 'Іi', 'ιi', 'Ιi', 'ӏl', 'Ӏl', 'еe', 'Еe', 'εe', 'Εe', 'гr'].map((p) => [p[0]!, p[1]!]),
);

/**
 * What a title looks like to a reader: format, control, separator, combining and default-ignorable characters gone (the
 * last takes the Hangul fillers, which are letters that render blank), as is the Braille blank U+2800, lookalikes as ASCII.
 * It uses NFKD, not NFKC: both fold compatibility forms, but NFKC would recompose an accented u into one character that
 * the combining-mark filter cannot see.
 */
function skeleton(title: string): string {
  return title.normalize('NFKD').replace(/[\p{Cf}\p{Cc}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}\u2800]/gu, '').replace(/./gu, (c) => LOOKALIKES[c] ?? c).toLowerCase();
}

/**
 * Why a node title is refused, or undefined when it is fine. This is a courtesy check, not a security boundary: it keeps
 * titles that look like the human's or the daemon's message labels (`human (answer to q-…)`, `tiller (daemon restarted)`)
 * out of the UI, where they would confuse a reader, and it cannot catch every lookalike. What stops a node from passing
 * a message off as theirs is the frame: a node's `from:` line always starts with its node id and quotes the title
 * (`from: n-620ed752 "lead"`), and theirs never does.
 * A title with a control character other than a tab is refused: the terminal would run it (an escape sequence in `tl ps`
 * can erase the line), and a vertical tab breaks a row. Format characters stay allowed, because emoji sequences use
 * the zero-width joiner.
 * The imitation check compares skeletons, not what was typed, so zero-width characters, lookalike letters and fullwidth
 * brackets do not get past it. A plain "tiller" is fine: it is the default title of a session in a folder of that name.
 */
export function reservedTitle(title: string): string | undefined {
  if (/[^\P{Cc}\t]/u.test(title)) return `refused: the title ${JSON.stringify(title.trim())} has a control character; use plain text`;
  const s = skeleton(title);
  return s === 'human' || /^(human|tiller)\(/.test(s)
    ? `refused: the title "${title.trim()}" imitates the label of a message from the human or Tiller; use "human" or "tiller" only with other words, such as "human-facing" or "tiller docs"`
    : undefined;
}
