/**
 * Whether a desktop toast is worth showing.
 *
 * Split out from the hook so the rule can be checked without a notification
 * service, and given its own gap rather than sharing the chime's: a toast is far
 * more intrusive than a two-note chime, and it lingers on screen long enough that
 * showing one every few seconds is a wall rather than a series.
 */

/**
 * Shortest gap between two toasts.
 *
 * A gift wave arrives as one frame per member. Without a gap the toast queue
 * becomes the gift's repeat count, and the one thing a notification is for — the
 * gift you did not see — is the thing that scrolled off.
 */
export const GIFT_NOTICE_GAP_MS = 8000

/** Whether a gift arriving now should raise a toast. */
export function shouldShowGiftNotice(
  enabled: boolean,
  lastShownAt: number | null,
  now: number,
  gapMs: number = GIFT_NOTICE_GAP_MS,
): boolean {
  if (!enabled) return false
  if (lastShownAt === null) return true
  return now - lastShownAt >= gapMs
}

/** The toast's two lines. */
export function noticeText(nickname: string, giftName: string, count: number, diamonds: number): {
  title: string
  body: string
} {
  const who = nickname.trim() || 'Someone'
  const what = count > 1 ? `${giftName} ×${count}` : giftName
  return {
    title: who,
    body: diamonds > 0 ? `${what} — ${diamonds} diamonds` : what,
  }
}