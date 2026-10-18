import { useEffect, useRef } from 'react'
import type { SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { useAudioPlayer } from '../lib/gate'
import { shouldPlaySound } from '../lib/sound'

type SoundEvent = Extract<SidecarEvent, { type: 'gift' | 'join' | 'follow' | 'share' }>

interface Options {
  type: SoundEvent['type']
  enabled: boolean
  templateId: string
  customPath: string
  volume: number
  gapMs: number
}

/**
 * A short, rate-limited sound for one kind of event: a gift, an arrival, a follow
 * or a share.
 *
 * The sound itself is a template the user picked, or a file they chose, played
 * through the shared player. This hook only decides *whether* to play and when —
 * the gap passed in is what keeps one gift wave, or one burst of arrivals, from
 * becoming a burst of sounds, and each caller reads its own gap from settings.
 * Gift, join, follow and share are one hook rather than four copies of the same
 * subscription and gap check, which differed only in the event name.
 */
export function useEventSound({ type, enabled, templateId, customPath, volume, gapMs }: Options): void {
  const { play } = useAudioPlayer()
  const lastPlayedAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== type) return
    const now = Date.now()
    if (!shouldPlaySound(enabled, lastPlayedAt.current, now, gapMs)) return
    lastPlayedAt.current = now
    void play(templateId, customPath, volume / 100)
  }, [type, enabled, templateId, customPath, volume, gapMs])

  useEffect(() => {
    if (!enabled) lastPlayedAt.current = null
  }, [enabled])
}
