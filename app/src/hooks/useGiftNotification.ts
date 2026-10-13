import { useEffect, useRef } from 'react'
import { host, type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { noticeText, shouldShowGiftNotice } from '../lib/notice'
import { giftAnnouncement } from '../lib/sound'
import { say, hush } from '../lib/voice'

/**
 * What a gift does besides chime and appear in the feed: a toast, and a voice.
 *
 * Both are gapped together, on the toast's gap rather than the chime's, because
 * they are the same announcement in two channels and one without the other reads
 * as a half-finished thing — a toast with no sound, or a voice naming a gift that
 * never appeared on screen. A gift wave arrives as one frame per member, so the
 * gap is what keeps one wave to one announcement instead of twenty.
 *
 * The voice is the shared one, so a gift arriving mid-sentence cuts off the chat
 * being read rather than talking over it.
 *
 * Failure is swallowed in both channels. A notification service that is off and a
 * voice service that is unreachable must not be able to take the feed down with
 * them — the same reasoning as the room status line admitting when it does not
 * know what is going on.
 */

interface Options {
  /** Raise a desktop toast. */
  notice: boolean
  /** Announce the gift with the neural voice. */
  voice: boolean
  /** How fast it speaks, from the settings the user picked. */
  ttsPace: string
}

export function useGiftNotification({ notice, voice, ttsPace }: Options): void {
  const lastShownAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== 'gift') return
    if (!notice && !voice) return

    const now = Date.now()
    if (!shouldShowGiftNotice(notice || voice, lastShownAt.current, now)) return
    lastShownAt.current = now

    const count = event.count ?? 1
    const diamonds = event.diamonds ?? 0

    if (notice) {
      const { title, body } = noticeText(event.nickname, event.giftName, count, diamonds)
      host.notify(title, body).catch(() => {
        // Windows declines toasts when the app has no registered shortcut, and a
        // declined toast is not something the user can act on.
      })
    }

    if (voice) {
      say(giftAnnouncement(event.nickname, event.giftName, count, diamonds), ttsPace)
    }
  }, [notice, voice, ttsPace])

  // Silence forgets when the last announcement was, so turning it back on does not
  // wait out a gap that started while it was off. The voice is stopped too, but
  // only when speech itself is off — a toast being switched off must not cut off a
  // gift that is currently being announced.
  useEffect(() => {
    if (!notice) lastShownAt.current = null
  }, [notice])
  useEffect(() => {
    if (!voice) hush()
  }, [voice])
}
