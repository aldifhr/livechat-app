import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useRoomEvents } from '../lib/reactive'
import type { SidecarEvent } from '../lib/sidecar'
import { AnimatedListItem } from './ui/animated-list'
import { Confetti, type ConfettiRef } from './ui/confetti'
import { TextAnimate } from './ui/text-animate'

/**
 * How many events may wait behind the one on screen.
 *
 * One popup shows for a few seconds, so a burst arrives faster than it can be
 * displayed — a gift train is exactly that. Unbounded, the queue grows without
 * limit and the backlog is not just late, it is *stale*: a toast about a gift from
 * two minutes ago, shown over a stream that has moved on. The cost is not only the
 * wait, either; every queued event holds its frame alive, and a busy room can
 * produce thousands.
 *
 * Twelve events bound the backlog. Past that the newest events win, because the reason to
 * show a gift at all is that it just happened.
 */
const MAX_QUEUED_POPUPS = 12

const POPUP_SIZE_CLASSES = {
  small: 'w-[min(300px,calc(100vw_-_32px))]',
  medium: 'w-[min(360px,calc(100vw_-_32px))]',
  large: 'w-[min(460px,calc(100vw_-_32px))]',
} as const

const PROGRESS_DURATION_CLASSES: Record<number, string> = {
  1000: 'duration-[1000ms]', 2000: 'duration-[2000ms]', 3000: 'duration-[3000ms]',
  4000: 'duration-[4000ms]', 5000: 'duration-[5000ms]', 6000: 'duration-[6000ms]',
  7000: 'duration-[7000ms]', 8000: 'duration-[8000ms]', 9000: 'duration-[9000ms]',
  10000: 'duration-[10000ms]',
}

const POPUP_TONE_CLASSES = {
  gift: {
    card: '[&[data-event-type=gift]]:[border-color:color-mix(in_srgb,var(--gold)_55%,transparent)]',
    eyebrow: 'text-app-gold',
    progress: '[&_span]:bg-app-gold',
  },
  follow: {
    card: '[&[data-event-type=follow]]:[border-color:color-mix(in_srgb,var(--follow)_58%,transparent)] [&[data-event-type=follow]]:[box-shadow:0_10px_32px_rgba(0,0,0,0.42),0_0_24px_color-mix(in_srgb,var(--follow)_12%,transparent)]',
    eyebrow: 'text-app-follow',
    progress: '[&_span]:bg-app-follow',
  },
  share: {
    card: '[&[data-event-type=share]]:[border-color:color-mix(in_srgb,var(--share)_58%,transparent)] [&[data-event-type=share]]:[box-shadow:0_10px_32px_rgba(0,0,0,0.42),0_0_24px_color-mix(in_srgb,var(--share)_12%,transparent)]',
    eyebrow: 'text-app-share',
    progress: '[&_span]:bg-app-share',
  },
} as const

type PopupEvent = Extract<SidecarEvent, { type: 'gift' | 'follow' | 'share' }>

function GiftPopupProgress({ durationMs, className }: { durationMs: number; className: string }) {
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setStarted(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  return (
    <div className={`gift-popup-progress h-[3px] w-full overflow-hidden rounded-full bg-app-line [&_span]:bg-app-gold ${className}`} aria-hidden="true">
      <span
        className={`block h-full w-full origin-left transition-[transform] ease-linear ${PROGRESS_DURATION_CLASSES[durationMs] ?? 'duration-[3000ms]'} ${started ? '[transform:scaleX(0)]' : '[transform:scaleX(1)]'}`}
      />
    </div>
  )
}

interface Props {
  enabled: { gift: boolean; follow: boolean; share: boolean }
  giftDurationSeconds: number
  giftSize: 'small' | 'medium' | 'large'
  giftPosition: 'center' | 'top' | 'bottom'
}

/** A brief queued toast for gifts, follows and shares. */
export function EventPopup({ enabled, giftDurationSeconds, giftSize, giftPosition }: Props) {
  const [activeEvent, setActiveEvent] = useState<PopupEvent | null>(null)
  const [eventQueue, setEventQueue] = useState<PopupEvent[]>([])
  const confettiRef = useRef<ConfettiRef>(null)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popupDurationMs = activeEvent?.type === 'gift' ? giftDurationSeconds * 1000 : 3_000

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
    }, popupDurationMs)
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
      dismissTimer.current = null
    }
  }, [activeEvent, popupDurationMs])

  const title = activeEvent?.type === 'gift'
    ? 'Gift received'
    : activeEvent?.type === 'follow'
      ? 'New follower'
      : 'Stream shared'
  const message = activeEvent?.type === 'gift'
    ? `${activeEvent.nickname || 'Someone'} ${activeEvent.giftName
      ? `sent ${activeEvent.count ?? 1} ${activeEvent.giftName}`
      : 'sent a gift'}`
    : activeEvent?.type === 'follow'
      ? `${activeEvent.nickname || 'Someone'} followed the stream`
      : activeEvent?.type === 'share'
        ? `${activeEvent.nickname || 'Someone'} shared the stream`
        : ''
  const detail = activeEvent?.type === 'gift'
    ? ''
    : activeEvent?.type === 'follow'
      ? 'Thanks for following!'
      : activeEvent?.type === 'share'
        ? 'Thanks for sharing!'
        : ''
  const image = activeEvent?.type === 'gift'
    ? activeEvent.giftImage || activeEvent.avatar
    : activeEvent?.avatar
  const popupSize = activeEvent?.type === 'gift' ? giftSize : 'medium'
  const popupPosition = activeEvent?.type === 'gift' ? giftPosition : 'center'
  const popupPositionClasses = popupPosition === 'top'
    ? '[place-items:start_center] [padding:24px_16px_0]'
    : popupPosition === 'bottom'
      ? '[place-items:end_center] [padding:0_16px_84px]'
      : '[place-items:center]'

  return (
    <>
      <Confetti ref={confettiRef} manualstart className="gift-confetti-canvas [position:fixed] [z-index:31] [inset:0] [width:100vw] [height:100vh] [pointer-events:none]" />
      <div
        className={`gift-popup-layer [position:fixed] [z-index:30] [inset:0] [display:grid] [pointer-events:none] ${popupPositionClasses}`}
        data-position={popupPosition}
        aria-live="polite"
        aria-atomic="true"
      >
        <AnimatePresence>
          {activeEvent && (
            <AnimatedListItem
              key={`${activeEvent.type}-${activeEvent.timestamp}-${activeEvent.id}`}
              className={`gift-popup-motion ${POPUP_SIZE_CLASSES[popupSize]}`}
            >
              <div className={`gift-popup-card [display:flex] [flex-direction:column] [gap:10px] [padding:14px_16px_10px] [border:1px_solid_var(--accent-soft)] [border-radius:14px] [background:var(--panel)] [color:var(--text)] [box-shadow:0_10px_32px_rgba(0,_0,_0,_0.42)] ${POPUP_TONE_CLASSES[activeEvent.type].card}`} data-event-type={activeEvent.type}>
                <div className="gift-popup-content [display:flex] [align-items:center] [gap:12px] [width:100%]">
                  {image && (
                    <img className="gift-popup-image [width:52px] [height:52px] [object-fit:contain] [flex:0_0_auto]" src={image} alt="" />
                  )}
                  <div className="gift-popup-copy [display:flex] [min-width:0] [flex-direction:column] [line-height:1.35]">
                    <TextAnimate
                      as="span"
                      className={`gift-popup-eyebrow [font-size:11px] [font-weight:700] [letter-spacing:0.08em] [text-transform:uppercase] ${POPUP_TONE_CLASSES[activeEvent.type].eyebrow}`}
                      animation="fadeIn"
                      by="word"
                      duration={0.28}
                      startOnView={false}
                    >
                      {title}
                    </TextAnimate>
                    <div className="gift-popup-message [font-weight:700] [overflow-wrap:anywhere] [white-space:normal]">{message}</div>
                    {detail && <span className="gift-popup-detail [color:var(--muted)] [font-size:12px]">{detail}</span>}
                  </div>
                </div>
                <GiftPopupProgress
                  key={`${activeEvent.type}-${activeEvent.timestamp}-${activeEvent.id}`}
                  durationMs={popupDurationMs}
                  className={POPUP_TONE_CLASSES[activeEvent.type].progress}
                />
              </div>
            </AnimatedListItem>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
