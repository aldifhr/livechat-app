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
function playTemplate(context: AudioContext, template: SoundTemplate, volume: number): void {
  const level = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1))
  for (const note of template.notes) {
    playNote(context, note.frequency, note.delayMs / 1000, note.durationMs, template.gain * note.level * level, template.wave)
    if (note.octave && note.octaveLevel) {
      // A beat late, like a struck string's harmonic.
      playNote(
        context,
        note.frequency * 2 ** note.octave,
        note.delayMs / 1000 + 0.02,
        note.durationMs,
        template.gain * note.level * note.octaveLevel * level,
        template.wave,
      )
    }
  }
}

/**
 * Files that have been decoded once and can be replayed, keyed by path.
 *
 * A map rather than the single slot this used to be. One slot was fine while one
 * custom file served every event, but with a file per event (gift, chat, join)
 * three paths are live at once, and a one-slot cache would evict each file the
 * moment another played — every blip in an active room would re-fetch and
 * re-decode from disk. Keyed, each file decodes once.
 *
 * Decoded to an AudioBuffer rather than played through an <audio> element so it
 * shares the AudioContext's clock and gain with the templates — a custom sound
 * that came out at a different volume, or a beat off, would read as a bug.
 */
const customBuffers = new Map<string, AudioBuffer>()
// In-flight loads, keyed by path, so a load for one file is never handed to a
// caller that asked for another, and two callers for the same file share one fetch.
const customLoads = new Map<string, Promise<AudioBuffer | null>>()

/** Forgets every decoded file, so a new pick is loaded fresh. */
export function invalidateCustomSound(): void {
  customBuffers.clear()
  customLoads.clear()
}

async function loadCustom(context: AudioContext, path: string): Promise<AudioBuffer | null> {
  const cached = customBuffers.get(path)
  if (cached) return cached
  // One in-flight load *per path*. The guard used to be a single flag, which meant
  // a request for /b.mp3 arriving while /a.mp3 was still decoding would await A's
  // load and return A's buffer — so picking a new sound played the old one. Keyed
  // on the path, so a second file starts its own load and a repeat shares the first.
  const pending = customLoads.get(path)
  if (pending) return pending

  // Held in an entry so the finally can compare against this exact load at
  // runtime (a bare `const promise` would be in its own temporal dead zone here).
  const entry: { promise: Promise<AudioBuffer | null> } = {
    promise: Promise.resolve(null),
  }
  entry.promise = (async (): Promise<AudioBuffer | null> => {
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
      customBuffers.set(path, buffer)
      return buffer
    } catch {
      // A missing, unreadable or undecodable file yields silence. The settings
      // dialog says when a pick failed; here it must not become a thrown error.
      return null
    } finally {
      // Cleared whether it resolved or failed, so a later play of the same path
      // retries rather than awaiting a settled promise forever. Guarded so a
      // decode that outlived a cache invalidation does not delete the entry a
      // newer load for the same path has already installed.
      if (customLoads.get(path) === entry.promise) customLoads.delete(path)
    }
  })()
  customLoads.set(path, entry.promise)
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
  volume = 1,
): Promise<AudioContext | null> {
  const resolved = context ?? resolveAudio()
  if (!resolved) return null
  resumeIfSuspended(resolved)

  if (customPath.trim() !== '') {
    const buffer = await loadCustom(resolved, customPath.trim())
    if (buffer) {
      const source = resolved.createBufferSource()
      source.buffer = buffer
      const gain = resolved.createGain()
      gain.gain.value = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1))
      source.connect(gain).connect(resolved.destination)
      source.start()
      return resolved
    }
    // A custom path that will not load falls through to the template rather than
    // to silence: the user asked for a sound, and a built-in one beats none.
  }

  playTemplate(resolved, resolveTemplate(templateId), volume)
  return resolved
}
