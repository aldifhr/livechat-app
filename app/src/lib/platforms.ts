/**
 * The platform, and what its feed actually contains.
 *
 * This is the one place that knows what TikTok can deliver. Everything
 * downstream — the feed, the filters, the log — is written against the shared
 * vocabulary, so adding a platform is a matter of extending this table and its
 * provider, not of teaching the UI about another set of rules.
 */

import type { FeedKind, Platform } from '../types'

export interface PlatformSpec {
  id: Platform
  label: string
  placeholder: string
  /** What the user is being asked to supply, in their terms. */
  targetLabel: string
  /**
   * The chat kinds this platform can actually deliver.
   *
   * A chip is only shown when the platform can fill it: offering a filter that
   * nothing can ever match presents an empty result with no explanation, which
   * reads as a broken app rather than an absent feature.
   */
  kinds: { value: FeedKind | 'all'; label: string }[]
}

/**
 * One platform today, as a record keyed by id.
 *
 * Still a table rather than a constant: it is what makes a second platform an
 * edit here rather than a search through the codebase.
 */
export const PLATFORMS: Record<Platform, PlatformSpec> = {
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    placeholder: '@username or tiktok.com/@username/live',
    targetLabel: 'username',
    kinds: [
      { value: 'all', label: 'All' },
      { value: 'chat', label: 'Chat' },
      { value: 'gift', label: 'Gifts' },
      { value: 'like', label: 'Likes' },
      { value: 'follow', label: 'Follows' },
      { value: 'share', label: 'Shares' },
      { value: 'join', label: 'Joined' },
    ],
  },
}

/** The only platform. Named rather than inlined so call sites read as intent. */
export const PLATFORM: Platform = 'tiktok'

/**
 * What a TikTok username is allowed to contain.
 *
 * Letters, digits, underscore and period, and nothing else — the whole set. Not an
 * approximation: a name with anything outside it cannot be a username however it is
 * encoded, so this is the test for whether a link can be built at all.
 */
const USERNAME = /^[A-Za-z0-9._]+$/

/**
 * Turns a name from a chat row into a TikTok username, or `''` if it cannot be one.
 *
 * A name from a chat row is not necessarily a username. The backend sends a stable
 * `userId` when it has one, but falls back to the nickname when it does not, and a
 * nickname is a display name — free text in any script. So this has to decide
 * whether it is holding a username or holding a name, and the difference matters
 * because the URL is opened in a browser and a wrong one is indistinguishable from
 * a dead account.
 *
 * A leading `@` is dropped: it is how a handle is written when a person types it and
 * never part of the username, and the URL already has one.
 *
 * An `@` anywhere else becomes `_`. This is the substitution case: `gmd@me` is a
 * display name for someone whose handle is `gmd_me`, and percent-encoding the `@`
 * produced `@gmd%40me` — well-formed, and an account that cannot exist. The
 * underscore gives the nearest username that could be real.
 *
 * Anything else outside `[A-Za-z0-9._]` is refused rather than fixed. `℘กัॐبَٱلرُّۚ ⸲ꪷ꫐ꪷ`
 * encodes into a long, perfectly valid percent-encoded URL, and there is no honest
 * way to turn that into a username — stripping the letters leaves fragments of four
 * languages that belong to no account. So there is no link, rather than a link that
 * is certain not to work.
 */
export function tiktokUsername(raw: string): string {
  const name = raw.trim().replace(/^@+/, '').replace(/@/g, '_')
  return USERNAME.test(name) ? name : ''
}

/**
 * The profile URL for a name from a chat row, or `''` when there is nothing to link.
 *
 * Built here rather than at each call site because getting it wrong is silent: the
 * host opens a well-formed URL to an account that does not exist, which looks like
 * a dead account rather than a bug. Empty means the caller shows a name, not a
 * link.
 */
export function tiktokProfileUrl(raw: string): string {
  const name = tiktokUsername(raw)
  return name === '' ? '' : `https://www.tiktok.com/@${encodeURIComponent(name)}`
}
