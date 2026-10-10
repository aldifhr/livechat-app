/**
 * Sound templates.
 *
 * A template is a short sequence of notes, described as data rather than as
 * oscillator calls, so the same shape can be played, previewed, tested and
 * serialised without an AudioContext. Each note is a frequency in Hz, a start
 * delay in ms, and a duration; the envelope and timbre are applied by the player.
 *
 * Kept separate from `sound.ts` because that file is the specific sound the app
 * shipped with, and this is the catalogue it grew into. The first template is
 * that sound, so nothing that exists changes.
 */

export type Waveform = 'sine' | 'square' | 'triangle' | 'sawtooth'

/** One note in a template. */
export interface TemplateNote {
  /** Frequency in Hz. */
  frequency: number
  /** Start offset from the template's beginning, in ms. */
  delayMs: number
  /** How long it rings, in ms. */
  durationMs: number
  /** Level relative to the template's master gain, 0..1. */
  level: number
  /** An octave partial, if the note has one. 0 for none. */
  octave?: number
  /** The partial's level, when there is one. */
  octaveLevel?: number
}

export interface SoundTemplate {
  id: string
  label: string
  hint: string
  /** The waveform every note in this template is played with. */
  wave: Waveform
  /** Master gain, 0..1. Deliberately quiet: these fire over a stream. */
  gain: number
  notes: TemplateNote[]
}

/**
 * The chime the app shipped with, as the first template.
 *
 * A fifth apart rather than an octave: an octave reads as "something broke" on a
 * speaker this small, while a fifth reads as a bell. Kept exactly as it was so
 * the default is unchanged by the templates being added.
 */
const CHIME_ROOT = 659.25

export const TEMPLATES: SoundTemplate[] = [
  {
    id: 'chime',
    label: 'Chime',
    hint: 'The default two-note bell',
    wave: 'sine',
    gain: 0.18,
    notes: [
      { frequency: CHIME_ROOT, delayMs: 0, durationMs: 420, level: 1, octave: 1, octaveLevel: 0.28 },
      { frequency: CHIME_ROOT * 1.5, delayMs: 95, durationMs: 420, level: 1, octave: 1, octaveLevel: 0.28 },
    ],
  },
  {
    id: 'blip',
    label: 'Blip',
    hint: 'One short high tap',
    wave: 'sine',
    gain: 0.1,
    notes: [{ frequency: 880, delayMs: 0, durationMs: 90, level: 1 }],
  },
  {
    id: 'coin',
    label: 'Coin',
    hint: 'A bright two-step, like a pickup',
    wave: 'square',
    gain: 0.12,
    notes: [
      { frequency: 988, delayMs: 0, durationMs: 80, level: 0.8 },
      { frequency: 1319, delayMs: 70, durationMs: 320, level: 1, octave: 1, octaveLevel: 0.2 },
    ],
  },
  {
    id: 'pop',
    label: 'Pop',
    hint: 'A soft rounded thump',
    wave: 'triangle',
    gain: 0.16,
    notes: [{ frequency: 440, delayMs: 0, durationMs: 140, level: 1 }],
  },
  {
    id: 'retro',
    label: 'Retro',
    hint: 'A square-wave arpeggio, 8-bit style',
    wave: 'square',
    gain: 0.09,
    notes: [
      { frequency: 523, delayMs: 0, durationMs: 90, level: 0.7 },
      { frequency: 659, delayMs: 80, durationMs: 90, level: 0.7 },
      { frequency: 784, delayMs: 160, durationMs: 90, level: 0.7 },
      { frequency: 1047, delayMs: 240, durationMs: 200, level: 0.9 },
    ],
  },
  {
    id: 'chirp',
    label: 'Chirp',
    hint: 'A quick rising sweep',
    wave: 'sawtooth',
    gain: 0.1,
    notes: [
      { frequency: 660, delayMs: 0, durationMs: 60, level: 0.6 },
      { frequency: 990, delayMs: 55, durationMs: 120, level: 0.8 },
    ],
  },
]

/** The template a saved id falls back to when it is no longer offered. */
export function resolveTemplate(id: string | null | undefined): SoundTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]
}

/**
 * How long a template lasts, in ms.
 *
 * The last note's end, not the count: a template with a note that starts late and
 * rings is longer than its note count suggests, and previewing or cutting off
 * speech on the wrong length is the kind of thing that is only obvious by ear.
 */
export function templateDurationMs(template: SoundTemplate): number {
  return template.notes.reduce((longest, note) => Math.max(longest, note.delayMs + note.durationMs), 0)
}
