import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useRoomEvents } from '../lib/reactive'
import type { SidecarEvent } from '../lib/sidecar'
import { AnimatedListItem } from './ui/animated-list'
import { Confetti, type ConfettiRef } from './ui/confetti'
import { TextAnimate } from './ui/text-animate'

const POPUP_DURATION_MS = 3_000

/**
 * How many events may wait behind the one on screen.
 *
 * One popup shows for three seconds, so a burst arrives faster than it can be
 * displayed — a gift train is exactly that. Unbounded, the queue grows without
 * limit and the backlog is not just late, it is *stale*: a toast about a gift from
 * two minutes ago, shown over a stream that has moved on. The cost is not only the
 * wait, either; every queued event holds its frame alive, and a busy room can
 * produce thousands.
 *
 * Twelve is a little over half a minute of backlog, which is the point past which a
 * popup stops being news. Past that the newest events win, because the reason to
 * show a gift at all is that it just happened.
 */
const MAX_QUEUED_POPUPS = 12

type PopupEvent = Extract<SidecarEvent, { type: 'gift' | 'follow' | 'share' }>

interface Props {
  enabled: { gift: boolean; follow: boolean; share: boolean }
}

/** A brief queued toast for gifts, follows and shares. */
export function EventPopup({ enabled }: Props) {
  const [activeEvent, setActiveEvent] = useState<PopupEvent | null>(null)
  const [eventQueue, setEventQueue] = useState<PopupEvent[]>([])
  const confettiRef = useRef<ConfettiRef>(null)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useRoomEvents((event) => {
    if (event.type !== 'gift' && event.type !== 'follow' && event.type !== 'share') return
    if (!enabled[event.type]) return
    setEventQueue((queue) => {
      const grown = [...queue, event]
      // Oldest first, so the backlog stays a window onto the recent past rather
      // than a queue that can never be drained. The event on screen is untouched:
      // it is not in this list.
      return grown.length > MAX_QUEUED_POPUPS
        ? grown.slice(grown.length - MAX_QUEUED_POPUPS)
        : grown
    })
  }, [enabled.gift, enabled.follow, enabled.share])

  // Applying a setting also removes matching events already waiting in line.
  useEffect(() => {
    setEventQueue((queue) => queue.filter((event) => enabled[event.type]))
    setActiveEvent((current) => current && !enabled[current.type] ? null : current)
  }, [enabled.gift, enabled.follow, enabled.share])

  // Promote only one event at a time. Incoming events stay queued while the
  // current toast is visible, so bursts are seen in order instead of replacing it.
  useEffect(() => {
    if (activeEvent || eventQueue.length === 0) return
    const [next, ...remaining] = eventQueue
    if (!next) return
    setEventQueue(remaining)
    setActiveEvent(next)
    if (typeof globalThis.addEventListener === 'function') {
      void confettiRef.current?.fire({
        particleCount: 90,
        spread: 72,
        startVelocity: 36,
        colors: next.type === 'gift'
          ? ['#d4af37', '#f2d675', '#fff1b8', '#b88920']
          : next.type === 'follow'
            ? ['#f472b6', '#fbcfe8', '#ffffff', '#d4af37']
            : ['#38bdf8', '#bae6fd', '#ffffff', '#d4af37'],
        origin: { x: 0.5, y: 0.5 },
      })
    }
  }, [activeEvent, eventQueue])

  useEffect(() => {
    if (!activeEvent) return
    dismissTimer.current = setTimeout(() => {
      dismissTimer.current = null
      setActiveEvent(null)
    }, POPUP_DURATION_MS)
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
      dismissTimer.current = null
    }
  }, [activeEvent])

  const title = activeEvent?.type === 'gift'
    ? 'Gift received'
    : activeEvent?.type === 'follow'
      ? 'New follower'
      : 'Stream shared'
  const message = activeEvent?.type === 'gift'
    ? `${activeEvent.nickname || 'Someone'} sent ${activeEvent.giftName || 'a gift'}`
    : activeEvent?.type === 'follow'
      ? `${activeEvent.nickname || 'Someone'} followed the stream`
      : activeEvent?.type === 'share'
        ? `${activeEvent.nickname || 'Someone'} shared the stream`
        : ''
  const detail = activeEvent?.type === 'gift'
    ? `x${activeEvent.count ?? 1}${(activeEvent.diamonds ?? 0) > 0 ? ` · ${activeEvent.diamonds} diamonds` : ''}`
    : activeEvent?.type === 'follow'
      ? 'Thanks for following!'
      : activeEvent?.type === 'share'
        ? 'Thanks for sharing!'
        : ''
  const image = activeEvent?.type === 'gift'
    ? activeEvent.giftImage || activeEvent.avatar
    : activeEvent?.avatar
  const popupDuration = `${POPUP_DURATION_MS}ms`

  return (
    <>
      <Confetti ref={confettiRef} manualstart className="gift-confetti-canvas" />
      <div className="gift-popup-layer" aria-live="polite" aria-atomic="true">
        <AnimatePresence>
          {activeEvent && (
            <AnimatedListItem
              key={`${activeEvent.type}-${activeEvent.timestamp}-${activeEvent.id}`}
              className="gift-popup-motion"
            >
              <div className={`gift-popup-card event-popup-${activeEvent.type}`}>
                <div className="gift-popup-content">
                  {image && (
                    <img className="gift-popup-image" src={image} alt="" />
                  )}
                  <div className="gift-popup-copy">
                    <TextAnimate
                      as="span"
                      className="gift-popup-eyebrow"
                      animation="fadeIn"
                      by="word"
                      duration={0.28}
                      startOnView={false}
                    >
                      {title}
                    </TextAnimate>
                    <div className="gift-popup-message">{message}</div>
                    <span className="gift-popup-detail">{detail}</span>
                  </div>
                </div>
                <div className="gift-popup-progress" aria-hidden="true">
                  <span style={{ animationDuration: popupDuration }} />
                </div>
              </div>
            </AnimatedListItem>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
