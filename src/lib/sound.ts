/**
 * What a gift sounds like.
 *
 * Synthesised rather than played from a file: an app that has to ship a binary
 * for one chime is worse than one that makes the chime, and a synthesised one is
 * still silent until the user has interacted with the app — which is exactly the
 * autoplay rule a live chat app should live under anyway.
 */

/**
 * Shortest gap between two sounds.
 *
 * A gift wave arrives as one frame per member, so without a gap a single wave
 * plays the chime as fast as the machine can schedule it — twenty notes that
 * fuse into one loud click. One sound per wave is the point; the rest of the wave
 * is the same gift.
 */
export const GIFT_SOUND_GAP_MS = 4000

/** Master level. Deliberately quiet: this fires over whatever else is playing. */
export const GIFT_SOUND_GAIN = 0.18

/** Base note. A fifth above middle C — bright without being shrill. */
const BASE_HZ = 659.25

/**
 * Whether a gift arriving now is worth hearing.
 *
 * `lastPlayedAt` is null before anything has played this session, and that case
 * is deliberately always allowed: a gift in a quiet room is the whole point of
 * the feature, and a gap measured from the start of time would let the first one
 * through by accident rather than by decision.
 */
export function shouldPlayGiftSound(
  enabled: boolean,
  lastPlayedAt: number | null,
  now: number,
  gapMs: number = GIFT_SOUND_GAP_MS,
): boolean {
  if (!enabled) return false
  if (lastPlayedAt === null) return true
  return now - lastPlayedAt >= gapMs
}

/**
 * The note a gift is played at.
 *
 * Scales with the value so the sound carries something: a streamer watching the
 * other window learns to hear a big gift rather than having to look. Capped at an
 * octave — past that it stops reading as a chime and starts reading as a mistake.
 */
export function giftPitch(diamonds: number): number {
  const value = Number.isFinite(diamonds) ? Math.max(0, diamonds) : 0
  // One octave up per 500 diamonds, held at the octave above the base note.
  const steps = Math.min(1, Math.floor(value / 500))
  return BASE_HZ * 2 ** steps
}

/**
 * The two notes of the chime, as [frequency, delay in ms] pairs.
 *
 * A fifth apart rather than an octave: an octave is the interval that reads as
 * "something broke" on a speaker this small, while a fifth reads as a bell.
 */
export function giftChord(diamonds: number): { frequency: number; delayMs: number }[] {
  const root = giftPitch(diamonds)
  return [
    { frequency: root, delayMs: 0 },
    { frequency: root * 1.5, delayMs: 95 },
  ]
}