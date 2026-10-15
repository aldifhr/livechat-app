import { useEffect, useRef } from 'react'
import { type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { useAudioPlayer } from '../lib/gate'
import { shouldPlayJoinSound } from '../lib/sound'

/**
 * A sound when somebody new arrives.
 *
 * Shaped like `useGiftSound` because it is the same job with a different event.
 * The subscription and the audio context are shared with it rather than written
 * out again — that boilerplate was lifted into `reactive.ts` and `gate.ts` for a
 * reason, and a fourth copy of it is a fourth chance to release the context on
 * an effect re-run instead of on unmount, which cuts the sound off mid-play the
 * moment anything else in the settings changes.
 *
 * What differs is the gap. It is longer than the chat blip's: an arrival is worth
 * less attention than a message, and one tap per person in a filling room says
 * "something is happening" without ever saying what. Shorter than the gift's,
 * because a gift is worth money and a join is worth a person, and the second
 * should not have to wait four seconds for the room to notice it.
 *
 * Worth being honest about what a join *is* here. TikTok batches its join events
 * rather than sending one per viewer — the bridge says so where it handles them —
 * so these arrive in bursts, and the gap is what stops a burst being a burst of
 * sounds. It is not there to thin out a trickle that was never thick.
 */

interface Options {
  enabled: boolean
  /** Which synthesised template to play when there is no custom file. */
  templateId: string
  /** A user-picked sound file, played instead of the template when set. */
  customPath: string
  volume: number
  gapMs: number
}

export function useJoinSound({ enabled, templateId, customPath, volume, gapMs }: Options): void {
  const { play } = useAudioPlayer()
  // A ref rather than state: read and written inside an event handler, and a
  // state update would be a render for a value nothing renders.
  const lastPlayedAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== 'join') return
    const now = Date.now()
    if (!shouldPlayJoinSound(enabled, lastPlayedAt.current, now, gapMs)) return
    lastPlayedAt.current = now
    // Fired and forgotten: the gap above is what keeps two arrivals from
    // overlapping, and awaiting here would let a rejection from a slow decode
    // surface as an unhandled rejection from the feed handler.
    void play(templateId, customPath, volume / 100)
  }, [enabled, templateId, customPath, volume, gapMs])

  // Turned off: forget when the last sound was, so the next one is not measured
  // against a gap that started before the user asked for silence.
  useEffect(() => {
    if (!enabled) lastPlayedAt.current = null
  }, [enabled])
}
