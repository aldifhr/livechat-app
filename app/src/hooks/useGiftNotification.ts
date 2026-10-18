import { useEffect, useRef } from 'react'
import { host, type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from './useRoomEvents'
import { noticeText, shouldShowGiftNotice } from '../lib/notice'
import { giftAnnouncement } from '../lib/sound'
import { say, hush } from '../lib/voice'
import type { VoiceOptions } from '../lib/voices'

/**
 * Gift toasts and voice announcements for gifts, follows and shares.
 *
 * Gift toast cooldowns are independent from voice. A gift wave arrives as one frame
 * per member, so the toast gap keeps one wave from producing a desktop toast per
 * person. Follow and share announcements use the same voice when enabled.
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
  giftVoice: boolean
  /** Announce follows with the neural voice. */
  followVoice: boolean
  /** Announce shares with the neural voice. */
  shareVoice: boolean
  /** Pace, language and volume for the voice, from the settings the user picked. */
  speech: VoiceOptions
}

export function useGiftNotification({ notice, giftVoice, followVoice, shareVoice, speech }: Options): void {
  // Two clocks, one per channel. They were a single `lastShownAt` gated by the
  // toast's eight-second gap, which meant the voice inherited it: any gift
  // arriving within eight seconds of the previous one was skipped entirely. On a
  // busy room that is almost every gift, so a streamer with read-aloud on heard
  // a gift only every eighth second and assumed the rest never arrived. The toast
  // still needs its long gap — it is a panel that lingers — but the voice has its
  // own gap inside `voice.ts`, measured from when the last sentence ended.
  const lastToastAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== 'gift' && event.type !== 'follow' && event.type !== 'share') return
    if (!notice && !giftVoice && !followVoice && !shareVoice) return

    if (event.type === 'follow') {
      if (followVoice) say(`${event.nickname.trim() || 'Someone'} followed the stream`, speech, 'event')
      return
    }
    if (event.type === 'share') {
      if (shareVoice) say(`${event.nickname.trim() || 'Someone'} shared the stream`, speech, 'event')
      return
    }

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

    if (giftVoice) {
      // Wait in the shared FIFO behind chat, so the announcement never cuts a
      // sentence short and never drops a line that arrived while chat was speaking.
      say(giftAnnouncement(event.nickname, event.giftName, count), speech, 'event')
    }
  }, [notice, giftVoice, followVoice, shareVoice, speech.pace, speech.language, speech.volume])

  // Silence forgets when the last toast was, so turning it back on does not wait
  // out a gap that started while it was off. The voice is stopped too, but only
  // when speech itself is off — a toast being switched off must not cut off a
  // gift that is currently being announced.
  useEffect(() => {
    if (!notice) lastToastAt.current = null
  }, [notice])
  useEffect(() => {
    if (!giftVoice && !followVoice && !shareVoice) hush('event')
  }, [giftVoice, followVoice, shareVoice])
}
