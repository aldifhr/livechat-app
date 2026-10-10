import { useEffect, useRef } from 'react'
import { attach, detachHandler, type SidecarEvent } from '../lib/sidecar'
import { playSound, resolveAudio } from '../lib/player'
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
  const contextRef = useRef<AudioContext | null>(null)
  // A ref rather than state: read and written inside an event handler, and a
  // state update would be a render for a value nothing renders.
  const lastPlayedAt = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    const ring = () => {
      const now = Date.now()
      if (!shouldPlayGiftSound(enabled, lastPlayedAt.current, now)) return
      lastPlayedAt.current = now

      contextRef.current ??= resolveAudio()
      // Awaited rather than fired and forgotten so a custom file that is still
      // decoding does not start a second, overlapping copy of itself on the next
      // gift inside the gap.
      void playSound(contextRef.current, templateId, customPath).then((used) => {
        contextRef.current = used
      })
    }

    const handle = (event: SidecarEvent) => {
      if (!active || event.type !== 'gift') return
      if (event.platform !== 'tiktok') return
      ring()
    }

    attach(handle)
    return () => {
      active = false
      // Taken back off rather than merely muted: this effect re-runs every time
      // the setting is toggled, and the set it subscribed to outlives it.
      detachHandler(handle)
    }
  }, [enabled, templateId, customPath])

  // Turned off: forget when the last sound was, so the next one is not measured
  // against a gap that started before the user asked for silence.
  useEffect(() => {
    if (!enabled) lastPlayedAt.current = null
  }, [enabled])
}
