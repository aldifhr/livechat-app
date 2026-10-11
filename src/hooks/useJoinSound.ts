import { useEffect, useRef } from 'react'
import { attach, detachHandler, type SidecarEvent } from '../lib/sidecar'
import { playSound, releaseAudio, resolveAudio } from '../lib/player'
import { shouldPlayJoinSound } from '../lib/sound'

/**
 * A sound when somebody new arrives.
 *
 * Shaped exactly like `useGiftSound` because it is exactly the same job with a
 * different event: subscribe, decide whether to sound, hand it to the shared
 * player. What differs is the gap, which is longer than the chat blip's — an
 * arrival is worth less attention than a message, and one tap per person in a
 * filling room says "something is happening" without ever saying what.
 *
 * Worth being honest about what a join *is* here: TikTok batches its join events
 * rather than sending one per viewer, so these arrive in bursts rather than one
 * per person. The gap is what keeps a burst from being a burst of sounds.
 *
 * The audio context is made on the first join rather than on mount, for the same
 * reason as everywhere else: browsers refuse to start audio before the page has
 * been interacted with, and asking earlier only gets back a context that is
 * silent for the rest of the session.
 */

interface Options {
  enabled: boolean
  /** Which synthesised template to play when there is no custom file. */
  templateId: string
  /** A user-picked sound file, played instead of the template when set. */
  customPath: string
}

export function useJoinSound({ enabled, templateId, customPath }: Options): void {
  const contextRef = useRef<AudioContext | null>(null)
  // A ref rather than state: read and written inside an event handler, and a
  // state update would be a render for a value nothing renders.
  const lastPlayedAt = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    const knock = () => {
      const now = Date.now()
      if (!shouldPlayJoinSound(enabled, lastPlayedAt.current, now)) return
      lastPlayedAt.current = now

      contextRef.current ??= resolveAudio()
      // Fired and forgotten: the gap above is what keeps two arrivals from
      // overlapping, and awaiting here would let a rejection from a slow decode
      // surface as an unhandled rejection from the feed handler.
      void playSound(contextRef.current, templateId, customPath).then((used) => {
        contextRef.current = used
      })
    }

    const handle = (event: SidecarEvent) => {
      if (!active || event.type !== 'join') return
      if (event.platform !== 'tiktok') return
      knock()
    }

    attach(handle)
    return () => {
      active = false
      // Taken back off rather than merely muted: this effect re-runs every time a
      // setting changes, and the set it subscribed to outlives it.
      detachHandler(handle)
    }
  }, [enabled, templateId, customPath])

  // This hook made its own context, so this hook closes it — on unmount only,
  // because the effect above re-runs every time a setting changes.
  useEffect(
    () => () => {
      contextRef.current = releaseAudio(contextRef.current)
    },
    [],
  )

  // Turned off: forget when the last sound was, so the next one is not measured
  // against a gap that started before the user asked for silence.
  useEffect(() => {
    if (!enabled) lastPlayedAt.current = null
  }, [enabled])
}