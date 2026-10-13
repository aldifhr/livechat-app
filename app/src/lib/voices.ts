/**
 * How fast the room is read aloud.
 *
 * Lives here, on the page, because it is the settings dialog's job to show the
 * choice. The host keeps its own copy of the same three values in `speech.rs` and
 * checks what arrives against it, so a stale saved setting cannot reach the voice
 * service as a pace it never heard of.
 *
 * These are paces rather than voices, and that is not a preference. Google's
 * read-aloud endpoint takes a language and nothing else: a `voice` parameter sent
 * to it is ignored and comes back as byte-identical audio, so there is exactly one
 * Indonesian voice to choose from. Speed is the one thing it does accept, so speed
 * is what the setting offers.
 */

/** The service's own pace — no `ttsspeed` is sent at all. */
export const NORMAL_PACE = 'normal'

export interface TtsPace {
  /** What is stored in settings and sent to the host. */
  value: string
  /** What the dialog calls it. */
  label: string
  /** Shown under the label: why this one and not the one above it. */
  note: string
}

export const TTS_PACES: readonly TtsPace[] = [
  {
    value: 'slow',
    label: 'Slow',
    note: 'Room moves faster than this, so it falls behind — good for a quiet room',
  },
  {
    value: NORMAL_PACE,
    label: 'Normal',
    note: 'What the voice service uses unless told otherwise',
  },
  {
    value: 'fast',
    label: 'Fast',
    note: 'Keeps up with a busy one, at the cost of sounding rushed',
  },
] as const

/**
 * Whether a stored value is still one this build offers.
 *
 * A settings file outlives the build that wrote it, so a pace that has since been
 * removed comes back from `localStorage` and would leave the dialog showing nothing
 * selected. It falls back to the default rather than showing a blank.
 */
export function knownPace(value: string): boolean {
  return TTS_PACES.some((pace) => pace.value === value)
}
