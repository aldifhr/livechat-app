import { useEffect, useRef } from 'react'
import type { SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { useAudioPlayer } from '../lib/gate'
import { shouldPlaySound } from '../lib/sound'

type SoundEvent = Extract<SidecarEvent, { type: 'follow' | 'share' }>

interface Options {
  type: SoundEvent['type']
  enabled: boolean
  templateId: string
  customPath: string
  volume: number
  gapMs: number
}

/** A short, rate-limited sound for a follow or share event. */
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
