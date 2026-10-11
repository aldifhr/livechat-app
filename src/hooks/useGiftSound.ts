import { useEffect, useRef } from 'react'
import { type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { useAudioPlayer } from '../lib/gate'
import { shouldPlayGiftSound } from '../lib/sound'

/**
 * Sounds on a gift.
 *
 * The sound itself is a template the user picks, or a file they chose, played
 * through the shared player. This hook only decides *whether* to play and when —
 * the gap that keeps one gift wave to one sound rather than a burst of them.
 *
 * The audio context is created on the first gift rather than on mount: browsers
 * refuse to start audio before the page has been interacted with, and asking for
 * it earlier only gets an unhelpfully silent context in return.
 */

interface Options {
  enabled: boolean
  /** Which synthesised template to play when there is no custom file. */
  templateId: string
  /** A user-picked sound file, played instead of the template when set. */
  customPath: string
}

export function useGiftSound({ enabled, templateId, customPath }: Options): void {
  const { play } = useAudioPlayer()
  // A ref rather than state: read and written inside an event handler, and a
  // state update would be a render for a value nothing renders.
  const lastPlayedAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== 'gift') return
    const now = Date.now()
    if (!shouldPlayGiftSound(enabled, lastPlayedAt.current, now)) return
    lastPlayedAt.current = now
    // Fired and forgotten deliberately: the gap check above is what keeps two
    // gifts from overlapping, and awaiting here would let a rejection from a slow
    // decode surface as an unhandled promise rejection.
    void play(templateId, customPath)
  }, [enabled, templateId, customPath])

  // Turned off: forget when the last sound was, so the next one is not measured
  // against a gap that started before the user asked for silence.
  useEffect(() => {
    if (!enabled) lastPlayedAt.current = null
  }, [enabled])
}
