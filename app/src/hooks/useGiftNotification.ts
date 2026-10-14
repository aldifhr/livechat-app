import { useEffect, useRef } from 'react'
import { host, type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { noticeText, shouldShowGiftNotice } from '../lib/notice'
import { giftAnnouncement } from '../lib/sound'
import { say, hush } from '../lib/voice'
import type { VoiceOptions } from '../lib/voices'

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
  /** Pace, language and volume for the voice, from the settings the user picked. */
  speech: VoiceOptions
}

export function useGiftNotification({ notice, voice, speech }: Options): void {
  // Two clocks, one per channel. They were a single `lastShownAt` gated by the
  // toast's eight-second gap, which meant the voice inherited it: any gift
  // arriving within eight seconds of the previous one was skipped entirely. On a
  // busy room that is almost every gift, so a streamer with read-aloud on heard
  // a gift only every eighth second and assumed the rest never arrived. The toast
  // still needs its long gap — it is a panel that lingers — but the voice has its
  // own gap inside `voice.ts`, measured from when the last sentence ended.
  const lastToastAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== 'gift') return
    if (!notice && !voice) return

    const now = Date.now()
    const count = event.count ?? 1
    const diamonds = event.diamonds ?? 0

    if (notice && shouldShowGiftNotice(true, lastToastAt.current, now)) {
      lastToastAt.current = now
      const { title, body } = noticeText(event.nickname, event.giftName, count, diamonds)
      host.notify(title, body).catch(() => {
        // Windows declines toasts when the app has no registered shortcut, and a
        // declined toast is not something the user can act on.
      })
    }

    if (voice) {
      // Ordinary: waits behind whatever chat sentence is still being read, and is
      // dropped by `voice.ts`'s own gap if one just finished. A gift announcement
      // that cuts off the reader mid-sentence is worse than one that arrives a
      // beat later — the chat is what the voice is primarily for.
      say(giftAnnouncement(event.nickname, event.giftName, count, diamonds), speech)
    }
  }, [notice, voice, speech.pace, speech.language, speech.volume])

  // Silence forgets when the last toast was, so turning it back on does not wait
  // out a gap that started while it was off. The voice is stopped too, but only
  // when speech itself is off — a toast being switched off must not cut off a
  // gift that is currently being announced.
  useEffect(() => {
    if (!notice) lastToastAt.current = null
  }, [notice])
  useEffect(() => {
    if (!voice) hush()
  }, [voice])
}
