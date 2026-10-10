import { useEffect, useRef } from 'react'
import { attach, detachHandler, type SidecarEvent } from '../lib/sidecar'
import { GIFT_SOUND_GAIN, giftChord, shouldPlayGiftSound } from '../lib/sound'

/**
 * Chimes on a gift.
 *
 * Built rather than sampled, so there is no asset to ship and no media source to
 * allow through the CSP. The context is created on the first gift rather than on
 * mount: browsers refuse to start audio before the page has been interacted with,
 * and asking for it earlier only gets an unhelpfully silent context in return.
 */

/** How long one note lasts. Long enough to ring, short enough not to pile up. */
const NOTE_MS = 420

/** Ramp time. Short: a slower attack reads as a swell, not as a chime. */
const ATTACK_MS = 12

type AudioContextConstructor = new () => AudioContext

/**
 * The browser's audio context, or null when there isn't one.
 *
 * Guarded rather than assumed. A webview without Web Audio — or a test running
 * in jsdom, which has none — must get silence and a working app, not an
 * exception thrown from an event handler on the busiest path there is.
 */
function resolveAudio(): AudioContext | null {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor
  }
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext
  if (!Constructor) return null
  try {
    return new Constructor()
  } catch {
    return null
  }
}

export function useGiftSound(enabled: boolean): void {
  const contextRef = useRef<AudioContext | null>(null)
  // A ref rather than state: this is read and written inside an event handler, and
  // a state update would be a render for a value nothing renders.
  const lastPlayedAt = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    const ring = (diamonds: number) => {
      const now = Date.now()
      if (!shouldPlayGiftSound(enabled, lastPlayedAt.current, now)) return
      lastPlayedAt.current = now

      contextRef.current ??= resolveAudio()
      const context = contextRef.current
      if (!context) return

      // Suspended until the user has interacted with the window; asking again is
      // cheap and is what makes the first chime audible at all.
      if (context.state === 'suspended') void context.resume()

      for (const note of giftChord(diamonds)) {
        playNote(context, note.frequency, note.delayMs / 1000)
      }
    }

    const handle = (event: SidecarEvent) => {
      if (!active || event.type !== 'gift') return
      if (event.platform !== 'tiktok') return
      ring(event.diamonds ?? 0)
    }

    attach(handle)
    return () => {
      active = false
      // Taken back off rather than merely muted: this effect re-runs every time
      // the setting is toggled, and the set it subscribed to outlives it.
      detachHandler(handle)
    }
  }, [enabled])

  // Turned off: forget when the last chime was, so the next one is not measured
  // against a gap that started before the user asked for silence.
  useEffect(() => {
    if (!enabled) lastPlayedAt.current = null
  }, [enabled])
}

/**
 * One note: a sine, its octave, and an envelope that rings down rather than cuts.
 *
 * The octave partial is quieter and a beat late, which is what gives a two-oscillator
 * chime its sense of being struck instead of dialled.
 */
function playNote(context: AudioContext, frequency: number, delaySeconds: number): void {
  const start = context.currentTime + delaySeconds
  const end = start + NOTE_MS / 1000

  const partials = [
    { ratio: 1, level: 1 },
    { ratio: 2, level: 0.28 },
  ]

  for (const [index, partial] of partials.entries()) {
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    const at = start + index * 0.02

    oscillator.type = 'sine'
    oscillator.frequency.value = frequency * partial.ratio

    // Never exactly zero: an exponential ramp from zero is undefined, and the
    // click that produces is audible over a stream.
    envelope.gain.setValueAtTime(0.0001, at)
    envelope.gain.linearRampToValueAtTime(GIFT_SOUND_GAIN * partial.level, at + ATTACK_MS / 1000)
    envelope.gain.exponentialRampToValueAtTime(0.0001, end)

    oscillator.connect(envelope).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(end + 0.02)
  }
}