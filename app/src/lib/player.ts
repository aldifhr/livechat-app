/**
 * The player.
 *
 * One place that turns "play this" into sound, whether the sound is a synthesised
 * template or a file the user picked. Both hooks used to build their own
 * oscillators; now they hand over a template id or a path and this decides how.
 *
 * A custom file wins over a template when both are set: the user went out of
 * their way to pick a file, and quietly ignoring it in favour of a built-in
 * would be the app overriding a decision it was given.
 *
 * Everything here is guarded. A webview without Web Audio, a file that fails to
 * load, a runtime with no media support — each must yield silence and a working
 * app, never an exception from an event handler on the busiest path there is.
 */

import { resolveTemplate, type SoundTemplate } from './templates'
import { mentionAlert } from './sound'
import { fileUrl } from './sidecar'

/** Attack time, in ms. Short: a slower attack reads as a swell, not as a tap. */
const ATTACK_MS = 12

type AudioContextConstructor = new () => AudioContext

/** The browser's audio context, or null when there isn't one. */
export function resolveAudio(): AudioContext | null {
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

/**
 * Closes a context a hook created, and forgets it.
 *
 * Each context holds an audio thread for as long as it is open. Four hooks each
 * made their own and none of them let go, so they accumulated for the life of the
 * window. Handing the context back here rather than closing it in the hook keeps
 * the closing in one place — a context a caller did not create is not the caller's
 * to close.
 */
export function releaseAudio(context: AudioContext | null | undefined): null {
  if (!context) return null
  try {
    void context.close()
  } catch {
    // A context that is already closed, or a runtime without close(). Either way
    // there is nothing left to release.
  }
  return null
}

/**
 * Resumes a suspended context.
 *
 * A context created before the user has interacted with the window starts
 * suspended and silent; asking again is cheap and is what makes the first sound
 * audible at all.
 */
function resumeIfSuspended(context: AudioContext): void {
  if (context.state === 'suspended') void context.resume()
}

/**
 * Plays one synthesised note: the wave, its octave partial, and an envelope that
 * rings down rather than cuts.
 *
 * The octave partial is quieter and a beat late, which is what gives a
 * two-oscillator note its sense of being struck instead of dialled.
 */
function playNote(
  context: AudioContext,
  frequency: number,
  delaySeconds: number,
  durationMs: number,
  level: number,
  wave: SoundTemplate['wave'],
): void {
  const start = context.currentTime + delaySeconds
  const end = start + durationMs / 1000

  const oscillator = context.createOscillator()
  const envelope = context.createGain()

  oscillator.type = wave
  oscillator.frequency.value = frequency

  // Never exactly zero: an exponential ramp from zero is undefined, and the click
  // that produces is audible over a stream.
  envelope.gain.setValueAtTime(0.0001, start)
  envelope.gain.linearRampToValueAtTime(level, start + ATTACK_MS / 1000)
  envelope.gain.exponentialRampToValueAtTime(0.0001, end)

  oscillator.connect(envelope).connect(context.destination)
  oscillator.start(start)
  oscillator.stop(end + 0.02)
}

/**
 * Plays the mention alert: two notes rising.
 *
 * Separate from the templates because it is not one of the choices — a mention is
 * the one sound in the app the user does not pick, because its job is to be
 * recognised without being looked up.
 */
export function playMention(context: AudioContext): void {
  const alert = mentionAlert()
  const start = context.currentTime
  playNote(context, alert.low, start, alert.durationMs, alert.gain, 'sine')
  playNote(context, alert.high, start + 0.09, alert.durationMs, alert.gain, 'sine')
}

/** Plays a whole template through the context. */
function playTemplate(context: AudioContext, template: SoundTemplate): void {
  for (const note of template.notes) {
    playNote(context, note.frequency, note.delayMs / 1000, note.durationMs, template.gain * note.level, template.wave)
    if (note.octave && note.octaveLevel) {
      // A beat late, like a struck string's harmonic.
      playNote(
        context,
        note.frequency * 2 ** note.octave,
        note.delayMs / 1000 + 0.02,
        note.durationMs,
        template.gain * note.level * note.octaveLevel,
        template.wave,
      )
    }
  }
}

/**
 * A file that has been decoded once and can be replayed.
 *
 * Decoded to an AudioBuffer rather than played through an <audio> element so it
 * shares the AudioContext's clock and gain with the templates — a custom sound
 * that came out at a different volume, or a beat off, would read as a bug.
 */
let customBuffer: { path: string; buffer: AudioBuffer } | null = null
// The in-flight load, carrying the path it is for. Keyed rather than bare so a
// load for one file is never handed to a caller that asked for another.
let customLoad: { path: string; promise: Promise<AudioBuffer | null> } | null = null

/** Forgets the decoded file, so a new pick is loaded fresh. */
export function invalidateCustomSound(): void {
  customBuffer = null
  customLoad = null
}

async function loadCustom(context: AudioContext, path: string): Promise<AudioBuffer | null> {
  if (customBuffer?.path === path) return customBuffer.buffer
  // One in-flight load *per path*. The guard used to be `customLoad !== null`,
  // which meant a request for /b.mp3 arriving while /a.mp3 was still decoding
  // would await A's load and return A's buffer — so picking a new sound played
  // the old one. Keyed on the path, so a second file starts its own load.
  if (customLoad && customLoad.path === path) {
    const pending = await customLoad.promise
    if (pending) return pending
  }
  const entry: { path: string; promise: Promise<AudioBuffer | null> } = { path, promise: null as unknown as Promise<AudioBuffer | null> }
  entry.promise = (async () => {
    try {
      // A path is not a URL a webview can request: it is rewritten onto the asset
      // protocol first, which is what the host registered the file against when
      // it was picked.
      const response = await fetch(await fileUrl(path))
      if (!response.ok) return null
      const bytes = await response.arrayBuffer()
      // A promise-based decode: the callback form would need a wrapper and both
      // are equally supported.
      const buffer = await context.decodeAudioData(bytes)
      // Stored only if this is still the file the app wants: a decode that
      // finishes after the user picked something else must not resurrect the
      // abandoned file as the cached one.
      if (customLoad === entry) customBuffer = { path, buffer }
      return buffer
    } catch {
      // A missing, unreadable or undecodable file yields silence. The settings
      // dialog says when a pick failed; here it must not become a thrown error.
      return null
    }
  })()
  customLoad = entry
  return entry.promise
}

/**
 * Plays whichever sound is configured: the custom file if one is set, otherwise
 * the template.
 *
 * Returns the context it used, so callers that want to chain a second sound can
 * share it rather than asking for another one.
 */
export async function playSound(
  context: AudioContext | null,
  templateId: string,
  customPath: string,
): Promise<AudioContext | null> {
  const resolved = context ?? resolveAudio()
  if (!resolved) return null
  resumeIfSuspended(resolved)

  if (customPath.trim() !== '') {
    const buffer = await loadCustom(resolved, customPath.trim())
    if (buffer) {
      const source = resolved.createBufferSource()
      source.buffer = buffer
      source.connect(resolved.destination)
      source.start()
      return resolved
    }
    // A custom path that will not load falls through to the template rather than
    // to silence: the user asked for a sound, and a built-in one beats none.
  }

  playTemplate(resolved, resolveTemplate(templateId))
  return resolved
}
