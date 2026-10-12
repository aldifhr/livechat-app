import { useMemo } from 'react'
import type { FeedItem } from '../types'

export type KindFilter = 'all' | FeedItem['kind']

export interface FeedFilters {
  kind: KindFilter
  search: string
}

/** Hiding rules that are preferences rather than filters the user picks per view. */
export interface HideOptions {
  joins: boolean
  filtered: boolean
}

/**
 * Which rows the feed shows, and which the counters count.
 *
 * One function for both on purpose: a user who filtered to "Gifts" and then read
 * the count beside the chip should be reading about the same set they are looking
 * at, and two functions is how those drift apart.
 */
export function useVisibleItems(
  items: FeedItem[],
  { kind, search }: FeedFilters,
  hide: HideOptions,
): FeedItem[] {
  return useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (kind === 'all' && !needle && !hide.joins && !hide.filtered) return items
    return items.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false
      // Hiding preferences are applied here rather than at render time so the chip
      // counts describe what is actually on screen.
      if (hide.joins && item.kind === 'join') return false
      if (hide.filtered && item.isFiltered) return false
      if (!needle) return true
      return (
        item.nickname.toLowerCase().includes(needle) ||
        (item.text ?? '').toLowerCase().includes(needle) ||
        (item.giftName ?? '').toLowerCase().includes(needle)
      )
    })
  }, [items, kind, search, hide.joins, hide.filtered])
}

/** Per-kind totals for the visible set, for the chip counts. */
export function useKindCounts(items: FeedItem[]): Record<string, number> {
  return useMemo(() => {
    const tally: Record<string, number> = {}
    for (const item of items) tally[item.kind] = (tally[item.kind] ?? 0) + 1
    return tally
  }, [items])
}