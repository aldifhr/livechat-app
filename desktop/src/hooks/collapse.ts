/**
 * Repeat suppression.
 *
 * Split out from `useFeed` so the decision can be tested on its own: it compares
 * several fields and a subtle mistake in it silently merges two different
 * messages into one row.
 */

/** Roughly the last few minutes in a busy room. */
export const MAX_ITEMS = 200

export interface CollapseOptions {
  windowMs: number
  threshold: number
}

interface Collapsible {
  kind: string
  id: string
  platform: string
  text?: string
  giftName?: string
  timestamp: number
}

/**
 * Whether `item` should fold into `newest` rather than becoming its own row.
 *
 * `platform` is part of the comparison because two rooms can be live at once in
 * principle, and without it a message from one could be counted as a repeat of
 * the row above it.
 */
export function collapseDecides(
  newest: Collapsible | undefined,
  item: Collapsible,
  { threshold, windowMs }: CollapseOptions,
): newest is Collapsible {
  if (threshold <= 0 || !newest) return false
  if (newest.kind !== item.kind) return false
  if (newest.platform !== item.platform) return false
  if (newest.id !== item.id) return false
  if (newest.text !== item.text) return false
  if (newest.giftName !== item.giftName) return false
  // Absolute, not a subtraction: out-of-order frames are possible across two
  // rooms polling at different rates, and a negative gap would always pass.
  return Math.abs(item.timestamp - newest.timestamp) < windowMs
}