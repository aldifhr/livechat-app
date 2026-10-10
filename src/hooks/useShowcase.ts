import { useEffect, useRef, useState } from 'react'
import { attach, detachHandler, type SidecarEvent } from '../lib/sidecar'

/**
 * What the overlay puts on screen.
 *
 * Not the chat: an overlay sits over the stream, so what belongs on it is the
 * handful of things worth reading from across the room — a gift, a burst of likes.
 * Everything else the bridge sends is dropped here rather than kept and hidden.
 */

/** Cards on screen at once. More than this and the overlay becomes a chat log. */
export const MAX_CARDS = 3

/** How long one card stays before it fades. */
export const CARD_LIFETIME_MS = 9000

/**
 * The smallest like burst worth showing.
 *
 * TikTok sends a like frame per pulse with a count attached, so showing all of
 * them turns the overlay into a ticker nobody can read. A big wave is worth the
 * space; the trickle that builds up to it is not.
 */
export const LIKE_WAVE_MIN = 25

export interface Card {
  key: string
  nickname: string
  avatar: string
  kind: 'gift' | 'like'
  label: string
  count: number
  diamonds: number
  /** Picture of the gift, when there is one. */
  image?: string
  /** Arrival time, which is what the lifetime runs from. */
  at: number
}

export interface Showcase {
  cards: Card[]
  viewers: number
}

function isRoom(platform: SidecarEvent['platform']): boolean {
  return platform === 'tiktok'
}

/**
 * Subscribes to the same frames the main window gets and keeps the big ones.
 *
 * Its own subscription rather than a share of the feed's: the feed is capped and
 * filtered for reading, and an overlay showing the last three rows of a filtered
 * view would put the wrong rows over the stream.
 */
export function useShowcase(): Showcase {
  const [cards, setCards] = useState<Card[]>([])
  const [viewers, setViewers] = useState(0)
  const sequence = useRef(0)

  useEffect(() => {
    let active = true

    const handle = (event: SidecarEvent) => {
      if (!active || !isRoom(event.platform)) return

      if (event.type === 'viewers') {
        setViewers(event.count)
        return
      }

      let card: Omit<Card, 'key' | 'at'> | null = null

      if (event.type === 'gift') {
        card = {
          nickname: event.nickname,
          avatar: event.avatar,
          kind: 'gift',
          label: event.giftName,
          count: event.count ?? 1,
          diamonds: event.diamonds ?? 0,
          ...(event.giftImage ? { image: event.giftImage } : {}),
        }
      } else if (event.type === 'like' && (event.count ?? 0) >= LIKE_WAVE_MIN) {
        card = {
          nickname: event.nickname,
          avatar: event.avatar,
          kind: 'like',
          label: 'likes',
          count: event.count ?? 0,
          diamonds: 0,
        }
      }

      if (!card) return

      sequence.current += 1
      // Built here rather than inside the updater below: React runs an updater at
      // render time, not at call time, so a burst of gifts queued in one batch
      // would all read the same counter and arrive as the same React key.
      const next: Card = { ...card, key: `t-${sequence.current}`, at: Date.now() }
      // Newest first: the thing that just happened is the thing being shown.
      setCards((previous) => [next, ...previous].slice(0, MAX_CARDS))
    }

    attach(handle)
    return () => {
      active = false
      detachHandler(handle)
    }
  }, [])

  // Ages the cards out. Only running while something is on screen, so a window
  // sitting idle over a stream does not wake once a second for the whole session.
  useEffect(() => {
    if (cards.length === 0) return
    const timer = setInterval(() => {
      setCards((previous) => previous.filter((card) => Date.now() - card.at < CARD_LIFETIME_MS))
    }, 1000)
    return () => clearInterval(timer)
  }, [cards.length])

  return { cards, viewers }
}