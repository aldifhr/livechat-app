import { useEffect, useRef } from 'react'
import { playSound, releaseAudio, resolveAudio } from './player'

/**
 * The audio-context machinery every sound hook rebuilds.
 *
 * Three hooks each held their own `AudioContext` ref, created it lazily on first
 * use, threaded it through `playSound`, and released it on unmount. That is not
 * just repeated — it is repeated with a trap each copy had to get right on its
 * own: release on unmount only, never when the effect re-runs, or a settings
 * change cuts a sound off mid-play. A copy that releases too eagerly is a hook
 * whose chime dies the moment the user toggles an unrelated setting.
 *
 * So the context lives here, with the release timing handled once.
 */

/**
 * A lazily-created AudioContext, shared across plays, released on unmount.
 *
 * Created on first use, not on mount: browsers refuse to start audio before the
 * page has been interacted with, and asking earlier only yields a silent context.
 * Released on unmount only — the hooks that use this re-run their effect on every
 * settings change, and closing there would cut a sound off mid-play, which is why
 * the release is tied to the component's life rather than the effect's.
 *
 * `play` shares the one context across calls, so two sounds chained together use
 * one context rather than each asking for another.
 */
export function useAudioPlayer(): { play: (templateId: string, customPath: string) => Promise<void> } {
  const contextRef = useRef<AudioContext | null>(null)

  useEffect(
    () => () => {
      contextRef.current = releaseAudio(contextRef.current)
    },
    [],
  )

  return {
    play: async (templateId: string, customPath: string) => {
      contextRef.current ??= resolveAudio()
      const used = await playSound(contextRef.current, templateId, customPath)
      contextRef.current = used
    },
  }
}
