/**
 * Whether a message is addressed to me.
 *
 * Pure, so the rule is checked without a feed and without a name to guess at. The
 * comparison is deliberately loose, and that is the whole of the design: TikTok is
 * not consistent about whether a mention arrives with its leading `@`, in what
 * case, or against a display name rather than a handle. A strict comparison would
 * miss the mentions that matter and catch none of the ones that do not.
 *
 * One handle is the common case, but the field accepts several comma-separated —
 * a person streams under one name and chats under another, and a mention of either
 * is a mention of them.
 */

/**
 * The handles from a comma-separated field.
 *
 * Trimmed, lowercased, `@` stripped, blanks dropped. An empty list is the default
 * and means nothing is ever a mention: a highlight that fires on the wrong name is
 * worse than no highlight, so this never guesses.
 */
export function myHandles(raw: string): string[] {
  return raw
    .split(',')
    .map((name) => name.trim().replace(/^@+/, '').toLowerCase())
    .filter((name) => name !== '')
}

/**
 * Whether a message's mentions include one of mine.
 *
 * Both sides are normalised the same way, because the mismatch this exists to
 * survive is entirely in the formatting: `@Ana`, `ana` and `ANA` are the same
 * person, and TikTok sends all three.
 */
export function mentionsMe(mentions: readonly string[] | undefined, mine: readonly string[]): boolean {
  if (!mentions?.length || mine.length === 0) return false
  const wanted = new Set(mine)
  return mentions.some((name) => wanted.has(String(name).trim().replace(/^@+/, '').toLowerCase()))
}
