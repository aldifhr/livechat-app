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

/** What this platform can deliver, as the filter chips offer it. */
export const KINDS: PlatformSpec['kinds'] = PLATFORMS[PLATFORM].kinds