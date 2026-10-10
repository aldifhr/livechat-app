import { useEffect, useMemo, useState } from 'react'
import {
  SPARK_INTERVAL_MS,
  SPARK_SAMPLES,
  addToBucket,
  emptyBuckets,
  ratePerMinute,
  rankChatters,
  type Bucket,
  type Chatter,
} from '../lib/stats'
import type { FeedItem, Platform } from '../types'

/**
 * Session statistics, kept beside the feed rather than derived from it.
 *
 * The feed is capped and drops its oldest rows, so anything computed from the list
 * it currently holds is only true for the last few minutes — which is precisely
 * the thing a session total must not be. Everything here accumulates as events
 * arrive and is never read back off the feed.
 */

export interface StatsSnapshot {
  /** Most recent viewer count. */
  viewers: number
  /** Sampled history, oldest first, one entry per `SPARK_INTERVAL_MS`. */
  viewerSeries: number[]
  peakViewers: number
  /** Chat messages over the last minute. */
  messagesPerMinute: number
  /** Highest rate seen this session, so a wave that has passed is still legible. */
  peakMessagesPerMinute: number
  totalMessages: number
  totalGifts: number
  totalFollows: number
  totalShares: number
  /** TikTok diamonds. Only TikTok, so there is nothing to split it by. */
  diamonds: number
  /** Distinct handles seen this session. Not a headcount. */
  people: number
  topChatters: Chatter[]
}

/**
 * Upper bound on tracked viewers.
 *
 * A long stream can name tens of thousands of them. Past the cap the totals keep
 * counting but new names stop being tracked, because the leaderboard only ever
 * shows ten rows and this map is what ranking walks.
 */
const MAX_TRACKED_CHATTERS = 20000

/** Ranking is O(people); once a second is far more often than the list changes. */
const RANK_EVERY_MS = 1000

/** How many names the leaderboard shows. */
const TOP_CHATTERS = 10

/**
 * What the recorder needs from an event.
 *
 * Structurally a subset of `FeedItem`, so a row headed for the feed can be handed
 * straight over: the recorder has no use for the React key or the repeat count,
 * and copying the row just to drop those fields would be an allocation per
 * message on the busiest path in the app.
 */
export interface StatsEvent {
  id: string
  nickname: string
  avatar: string
  platform: Platform
  kind: FeedItem['kind']
  diamonds?: number
}

export interface StatsRecorder {
  /** Counts one feed event. Called from the same place the feed is pushed. */
  record: (item: StatsEvent) => void
  /** The room's latest headcount, whenever TikTok reports one. */
  setViewers: (count: number) => void
  /**
   * Takes one viewer sample. Driven by the panel's timer rather than by events: a
   * room reports its headcount whether anyone is talking or not, and a flat line
   * on the sparkline is a real reading rather than a missing sample.
   */
  sample: () => void
  /** Drops everything, for a new room. */
  reset: () => void
  /**
   * The current numbers.
   *
   * Idempotent: ranking is cached, so React's double-render in StrictMode costs
   * the same as a single pass and the result does not change between them.
   */
  read: () => StatsSnapshot
  /** Subscribes to "something changed". Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void
}

/**
 * Builds an accumulator.
 *
 * A plain factory rather than a hook because `useChat` holds it in a ref and the
 * panel subscribes to it from a different component: the two must share one
 * instance without either re-rendering the other.
 */
export function createStats(): StatsRecorder {
  let buckets: Bucket[] = emptyBuckets()
  let series: number[] = []
  let peak = 0
  let viewers = 0
  let diamonds = 0
  const chatters = new Map<string, Chatter>()

  let messages = 0
  let gifts = 0
  let follows = 0
  let shares = 0
  let people = 0
  let peakRate = 0

  let ranked: Chatter[] = []
  let rankedFor = -1
  let rankedAt = 0

  const listeners = new Set<() => void>()
  let pending: ReturnType<typeof setTimeout> | null = null

  /**
   * Coalesced, so a burst is one re-render rather than hundreds.
   *
   * A busy room emits events faster than anyone can read a number that only
   * changes once a minute, and re-sorting the leaderboard per event is the
   * expensive part of it.
   */
  function notify() {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      for (const listener of listeners) listener()
    }, 250)
  }

  function chatterFor(item: StatsEvent): Chatter | undefined {
    const existing = chatters.get(item.id)
    if (existing) return existing
    // Counted even when there is no room left to name them in, so the total stays
    // true past the cap.
    people += 1
    if (chatters.size >= MAX_TRACKED_CHATTERS) return undefined
    const created: Chatter = {
      id: item.id,
      nickname: item.nickname,
      avatar: item.avatar,
      platform: item.platform,
      messages: 0,
      gifts: 0,
      diamonds: 0,
      follows: 0,
      shares: 0,
    }
    chatters.set(item.id, created)
    return created
  }

  function record(item: StatsEvent): void {
    // Likes are room-level pulses with nobody worth ranking behind them, and a
    // join is derived from a viewer's first chat message, so both would count
    // people the switch below already counted.
    if (item.kind === 'like' || item.kind === 'join') return

    const chatter = chatterFor(item)

    switch (item.kind) {
      case 'chat':
        messages += 1
        if (chatter) chatter.messages += 1
        break
      case 'gift':
        gifts += 1
        // Already a total on the wire, not a unit price: the bridge multiplies by
        // the repeat count before it sends the frame.
        diamonds += item.diamonds ?? 0
        if (chatter) {
          chatter.gifts += 1
          chatter.diamonds += item.diamonds ?? 0
        }
        break
      case 'follow':
        follows += 1
        if (chatter) chatter.follows += 1
        break
      case 'share':
        shares += 1
        if (chatter) chatter.shares += 1
        break
    }

    // Arrival time, not the frame's timestamp: frames arrive out of order
    // across the socket, so a rate built from the wire timestamps would not be a
    // rate of anything.
    const now = Date.now()
    buckets = addToBucket(buckets, now)
    const current = ratePerMinute(buckets, now)
    // Only raised, never lowered: a wave that has already gone is exactly what a
    // peak is for, and the live rate is a separate number on the panel.
    if (current > peakRate) peakRate = current
    notify()
  }

  function setViewers(count: number): void {
    viewers = count
    // Raised here and not only when a sample is taken. The two run on different
    // clocks — a headcount arrives whenever TikTok reports one, a sample every
    // few seconds — so a room that has just grown past the last sample would
    // otherwise show a peak below its own current count.
    if (count > peak) peak = count
    // Notified here too, or the count on the collapsed bar would sit up to a
    // sample behind the one on the room's own status line — which is the number
    // the collapsed bar exists to show.
    notify()
  }

  function sample(): void {
    const next = [...series, viewers]
    series = next.length > SPARK_SAMPLES ? next.slice(next.length - SPARK_SAMPLES) : next
    notify()
  }

  function reset(): void {
    buckets = emptyBuckets()
    series = []
    peak = 0
    viewers = 0
    diamonds = 0
    chatters.clear()
    messages = 0
    gifts = 0
    follows = 0
    shares = 0
    people = 0
    peakRate = 0
    ranked = []
    rankedFor = -1
    rankedAt = 0
    notify()
  }

  function top(): Chatter[] {
    const now = Date.now()
    if (rankedFor === chatters.size && now - rankedAt < RANK_EVERY_MS) return ranked
    ranked = rankChatters(chatters.values(), TOP_CHATTERS)
    rankedFor = chatters.size
    rankedAt = now
    return ranked
  }

  function read(): StatsSnapshot {
    return {
      viewers,
      viewerSeries: [...series],
      peakViewers: peak,
      messagesPerMinute: ratePerMinute(buckets, Date.now()),
      peakMessagesPerMinute: peakRate,
      totalMessages: messages,
      totalGifts: gifts,
      totalFollows: follows,
      totalShares: shares,
      diamonds,
      people,
      topChatters: top(),
    }
  }

  return {
    record,
    setViewers,
    sample,
    reset,
    read,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Subscribes a component to a recorder and re-renders it as the numbers move.
 *
 * The timer lives here, mounted once by the panel, so the feed above it never
 * re-renders because a viewer count moved.
 */
export function useStats(stats: StatsRecorder): StatsSnapshot {
  const [version, setVersion] = useState(0)

  useEffect(() => stats.subscribe(() => setVersion((n) => n + 1)), [stats])

  useEffect(() => {
    // One sample up front, so the chart has a baseline and the peak has something
    // to compare against before the first tick rather than showing empty for the
    // first few seconds of a stream.
    stats.sample()
    const timer = setInterval(() => {
      stats.sample()
      // Bumped even when nothing arrived, so a rate that should be falling does
      // fall: an idle room must not keep showing the count it had when it went
      // quiet.
      setVersion((n) => n + 1)
    }, SPARK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [stats])

  // Keyed on `version` rather than re-reading on every render: `read` walks the
  // leaderboard, and nothing about the result depends on anything else.
  return useMemo(() => stats.read(), [stats, version])
}