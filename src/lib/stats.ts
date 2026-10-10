/**
 * Stream statistics.
 *
 * Pure: the accumulator in `useStats` owns the mutable state, everything here is a
 * function over it, so the numbers can be checked without React, a clock, or a
 * live stream — which matters, because a wrong viewer count is indistinguishable
 * from a wrong one on screen.
 */

import type { Platform } from '../types'

/** Samples kept for a viewer sparkline. */
export const SPARK_SAMPLES = 120

/** How often one is taken. 120 × 5s is the last ten minutes. */
export const SPARK_INTERVAL_MS = 5000

/** The window the message rate is measured over. */
export const RATE_WINDOW_MS = 60000

/**
 * One-second buckets, one entry per second of the rate window.
 *
 * Buckets rather than a rolling list of timestamps because a busy room emits
 * hundreds of events a minute and the panel re-reads them on a timer: counting
 * into a fixed ring is O(1) per event and O(60) per read, whatever the rate.
 */
export const RATE_BUCKETS = Math.ceil(RATE_WINDOW_MS / 1000)

/** One bucket: how many events landed in the second beginning at `at`. */
export interface Bucket {
  at: number
  count: number
}

/** Which second of the ring a timestamp belongs to. */
function bucketSlot(at: number): number {
  return Math.floor(at / 1000) % RATE_BUCKETS
}

/**
 * An empty rate window.
 *
 * Pre-filled rather than grown on demand so every slot has a timestamp: an unused
 * slot is marked with a time no real event can carry, which is what lets the
 * reader below tell "nothing happened here" from "this second was never written".
 */
export function emptyBuckets(): Bucket[] {
  return Array.from({ length: RATE_BUCKETS }, () => ({ at: -1, count: 0 }))
}

/**
 * Counts one event into the ring, reusing the slot for its second.
 *
 * Snapped to the second first. Comparing raw timestamps instead makes every event
 * its own bucket, so a room sending forty messages a second would report a rate of
 * one — the number is only as good as the key it is counted under.
 */
export function addToBucket(buckets: Bucket[], at: number, count = 1): Bucket[] {
  const second = Math.floor(at / 1000) * 1000
  const slot = bucketSlot(second)
  const current = buckets[slot]
  const next = [...buckets]
  next[slot] =
    current.at === second ? { at: second, count: current.count + count } : { at: second, count }
  return next
}

/**
 * Events in the last `windowMs`, as a per-minute figure.
 *
 * Only the lower bound is applied. Frames carry a timestamp taken before they
 * reached us and arrive out of order, and dropping the early ones would silently
 * undercount the busiest moment of a stream.
 */
export function ratePerMinute(buckets: Bucket[], now: number, windowMs = RATE_WINDOW_MS): number {
  const floor = now - windowMs
  let total = 0
  for (const bucket of buckets) {
    if (bucket.at > floor) total += bucket.count
  }
  return windowMs === RATE_WINDOW_MS ? total : Math.round((total * 60000) / windowMs)
}

/** One viewer's totals for the session. */
export interface Chatter {
  /** The platform's stable handle. Nicknames change and collide between rooms. */
  id: string
  nickname: string
  avatar: string
  platform: Platform
  messages: number
  gifts: number
  /** Already a total, not a unit price: the bridge multiplies by the repeat count. */
  diamonds: number
  follows: number
  shares: number
}

/** Whether this viewer did anything at all. Watching is not participating. */
function tookPart(chatter: Chatter): boolean {
  return chatter.messages + chatter.gifts + chatter.follows + chatter.shares > 0
}

/**
 * The busiest viewers, most messages first.
 *
 * Diamonds break ties rather than setting the order: someone who sends one big
 * gift has done something worth seeing, but ranking them above the person who has
 * talked to the room two hundred times would read as a bug.
 */
export function rankChatters(chatters: Iterable<Chatter>, limit: number): Chatter[] {
  return [...chatters]
    .filter((chatter) => tookPart(chatter))
    .sort((a, b) => {
      if (b.messages !== a.messages) return b.messages - a.messages
      if (b.diamonds !== a.diamonds) return b.diamonds - a.diamonds
      if (b.gifts !== a.gifts) return b.gifts - a.gifts
      // Nickname last so the board does not reshuffle between otherwise equal
      // rows on every event, which reads as the app flickering.
      return a.nickname.localeCompare(b.nickname)
    })
    .slice(0, limit)
}

export interface SparkPath {
  /** The line itself. */
  line: string
  /** The same line closed to the baseline, for the fill under it. */
  area: string
}

/**
 * An SVG path for a sparkline.
 *
 * Scaled to the series' own range rather than to zero: a room hovering around
 * 300 viewers for an hour would otherwise draw a flat line along the floor and
 * look dead. The flat case is drawn through the middle instead, because a series
 * that genuinely never moved is information too.
 */
export function sparkPath(values: number[], width: number, height: number, pad = 2): SparkPath {
  if (values.length === 0) return { line: '', area: '' }

  const innerWidth = Math.max(1, width - pad * 2)
  const innerHeight = Math.max(1, height - pad * 2)
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min)) return { line: '', area: '' }

  const span = max - min
  const step = values.length === 1 ? 0 : innerWidth / (values.length - 1)

  const points = values.map((value, index) => {
    const ratio = span === 0 ? 0.5 : (value - min) / span
    const x = round(pad + index * step)
    const y = round(pad + innerHeight - ratio * innerHeight)
    return `${x},${y}`
  })

  const line = `M${points.join('L')}`
  const baseline = round(pad + innerHeight)
  return { line, area: `${line}L${round(pad + innerWidth)},${baseline}L${round(pad)},${baseline}Z` }
}

/** Two decimals at most, so the path stays short without losing the shape. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}