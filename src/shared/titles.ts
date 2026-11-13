/**
 * Lookalikes of the letters h u m a n t i l e r that compatibility normalization does not fold. The scope is the common Cyrillic and Greek
 * letters, not all of Unicode's confusables. Capitals are listed too, because lowercasing would send Greek capital Η
 * (looks like H) and lowercase η (looks like n) to the same letter. Fullwidth and other compatibility forms, such as
 * the fullwidth parenthesis, are already folded by NFKD, and no non-ASCII parenthesis is left that reads as one.
 */
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  ['һh', 'Һh', 'Нh', 'Ηh', 'уu', 'υu', 'мm', 'Мm', 'μm', 'Μm', 'аa', 'Аa', 'αa', 'Αa', 'нn', 'ηn', 'Νn', 'тt', 'Тt', 'τt', 'Τt', 'іi', 'Іi', 'ιi', 'Ιi', 'ӏl', 'Ӏl', 'еe', 'Еe', 'εe', 'Εe', 'гr'].map((p) => [p[0]!, p[1]!]),
);

/**
 * What a title looks like to a reader: format, control, separator and combining characters gone, lookalikes as ASCII.
 * It uses NFKD, not NFKC: both fold compatibility forms, but NFKC would recompose an accented u into one character that
 * the combining-mark filter cannot see.
 */
function skeleton(title: string): string {
  return title.normalize('NFKD').replace(/[\p{Cf}\p{Cc}\p{Z}\p{M}]/gu, '').replace(/./gu, (c) => LOOKALIKES[c] ?? c).toLowerCase();
}

/**
 * Why a node title is refused, or undefined when it is fine. A node's messages read `from: <title> (<id>)`, while the
 * human's and the daemon's read `human (answer to q-…)`, `tiller (daemon restarted)` and so on, so a title whose
 * skeleton is "human", or is or starts with "human(" or "tiller(", could pass for one of them. Titles are compared by
 * skeleton, not as typed, so zero-width characters, lookalike letters and fullwidth brackets do not get past.
 * A plain "tiller" is fine: it is the default title of a session in a folder of that name. So are emoji titles, which
 * use the zero-width joiner: only the skeleton is checked, never the raw characters.
 */
export function reservedTitle(title: string): string | undefined {
  const s = skeleton(title);
  return s === 'human' || /^(human|tiller)\(/.test(s)
    ? `refused: the title "${title.trim()}" imitates the label of a message from the human or Tiller; use "human" or "tiller" only with other words, such as "human-facing" or "tiller docs"`
    : undefined;
}
