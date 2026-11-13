/**
 * Why a node title is refused, or undefined when it is fine. A node's messages read `from: <title> (<id>)`, while the
 * human's and the daemon's read `human (answer to q-…)`, `tiller (daemon restarted)` and so on, so a title that is
 * "human", or that is or starts with "human" or "tiller" followed by a parenthesis, could pass for one of them.
 * A plain "tiller" is fine: it is the default title of a session in a folder of that name.
 */
export function reservedTitle(title: string): string | undefined {
  return /^\s*(human|tiller)\s*\(/i.test(title) || /^\s*human\s*$/i.test(title)
    ? `refused: the title "${title.trim()}" imitates the label of a message from the human or Tiller; use "human" or "tiller" only with other words, such as "human-facing" or "tiller docs"`
    : undefined;
}
