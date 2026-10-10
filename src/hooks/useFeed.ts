import { useCallback, useMemo, useRef, useState } from 'react'
import type { FeedItem, FeedKind } from '../types'

/**
 * One item per live event, plus the derived counters.
 *
 * A busy room emits a few hundred comments a minute, so the list is capped. The
 * cap drops the oldest entries, which is why keys are monotonic per item rather
 * than reused indexes: React keys must stay stable as the window slides.
 */

import { MAX_ITEMS, collapseDecides } from './collapse'

export interface UseFeedResult {
  items: FeedItem[]
  push: (item: FeedInput) => void
  clear: () => void
  /** Total events received this session, including ones the cap has dropped. */
  totalReceived: number
}

/** What a producer hands over. `key` is assigned here, not by the caller. */
export type FeedInput = Omit<FeedItem, 'key' | 'repeatCount'>

export interface CollapseOptions {
  windowMs: number
  threshold: number
}

export function useFeed(collapse: CollapseOptions): UseFeedResult {
  const [items, setItems] = useState<FeedItem[]>([])
  const [totalReceived, setTotalReceived] = useState(0)

  // Monotonic per-session counter. A ref rather than the array length because the
  // list is capped, and a ref rather than state because it must be correct inside
  // the state updater below, which may not run during this call.
  const sequence = useRef(0)

  const push = useCallback(
    (item: FeedInput) => {
      sequence.current += 1
      const seq = sequence.current
      setTotalReceived(seq)

      setItems((previous) => {
        // Oldest first, newest at the bottom, the way a chat log reads. The feed
        // scrolls toward the tail, so appending is also what keeps autoscroll
        // meaningful — prepending would put every new row out of view.
        const newest = previous[previous.length - 1]
        if (collapseDecides(newest, item, collapse)) {
          // The row is mutated in place and returned inside a new array so React
          // re-renders that one row. A copy would break the identity that keys
          // the list and remount every row on each repeat.
          newest.repeatCount = (newest.repeatCount ?? 1) + 1
          return [...previous.slice(0, -1), newest]
        }

        const key = `${item.timestamp}-${seq}-${item.platform}-${item.id}`
        const combined: FeedItem[] = [...previous, { ...item, key, repeatCount: 1 }]
        // Dropped from the front: the oldest rows are the ones worth losing.
        return combined.length > MAX_ITEMS ? combined.slice(combined.length - MAX_ITEMS) : combined
      })
    },
    [collapse.threshold, collapse.windowMs],
  )

  const clear = useCallback(() => {
    sequence.current = 0
    setItems([])
    setTotalReceived(0)
  }, [])

  return useMemo(
    () => ({ items, push, clear, totalReceived }),
    [items, push, clear, totalReceived],
  )
}

export function kindLabel(kind: FeedKind): string {
  switch (kind) {
    case 'gift':
      return 'sent a gift'
    case 'like':
      return 'liked the stream'
    case 'follow':
      return 'followed'
    case 'share':
      return 'shared the stream'
    default:
      return ''
  }
}