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
 * Turns a name from a chat row into a TikTok username.
 *
 * Two fixes, both because a TikTok username cannot contain what these rows carry.
 *
 * A leading `@` is dropped: it is how a handle is written when a person types it
 * and never part of the username itself, and the URL already has one.
 *
 * An `@` anywhere else becomes `_`. This is the case that matters. When the
 * backend sends no stable `userId`, `id` falls back to the nickname, and a nickname
 * is a display name — which may well read `gmd@me` for someone whose actual handle
 * is `gmd_me`. Percent-encoding that produced `@gmd%40me`, a URL for an account
 * that cannot exist: TikTok usernames are letters, digits, `_` and `.`, and `@` is
 * the sigil that introduces a handle, not a character inside one. Substituting the
 * underscore gives the nearest username that could be real.
 *
 * It is a substitution rather than a refusal because refusing would leave the row
 * with no profile link at all, and a link that goes to the wrong account is worth
 * less than one that goes to the right one but only sometimes.
 */
export function tiktokUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').replace(/@/g, '_')
}

/**
 * The profile URL for a name from a chat row, or `''` if there is no name.
 *
 * Built here rather than at each call site because getting it wrong is silent: the
 * host opens a well-formed URL to an account that does not exist, which looks like
 * a dead account rather than a bug.
 */
export function tiktokProfileUrl(raw: string): string {
  const name = tiktokUsername(raw)
  return name === '' ? '' : `https://www.tiktok.com/@${encodeURIComponent(name)}`
}
