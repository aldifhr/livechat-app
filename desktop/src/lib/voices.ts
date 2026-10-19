/**
 * How the room is read aloud: how fast, in what language, and how loud.
 *
 * Lives here, on the page, because it is the settings dialog's job to show the
 * choices. The host keeps its own copy of the languages in `speech.rs` and checks
 * what arrives against it, so a stale saved setting cannot reach the voice service
 * as a language code it never heard of.
 *
 * These are paces rather than voices, and that is not a preference. Google's
 * read-aloud endpoint takes a language and nothing else: a `voice` parameter sent
 * to it is ignored and comes back as byte-identical audio, so there is one voice per
 * language and nothing to pick between within one. Speed is the one thing it accepts
 * beyond the language, so speed is what the setting offers — and language is the
 * closest thing to a voice picker this engine can honestly be.
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

/** The language asked for when nothing has chosen one: the chat's own. */
export const DEFAULT_LANGUAGE = 'id'

export interface TtsLanguage {
  /** What is stored in settings and sent to the host. */
  value: string
  /** What the dialog calls it. */
  label: string
  /**
   * What the Tester speaks.
   *
   * In the language it is testing, which is the whole point of it. A sample fixed
   * to one language tells you nothing about the other: an Indonesian phrase read by
   * an English voice is audible evidence of exactly the thing you were checking.
   */
  sample: string
}

/**
 * The languages offered.
 *
 * A short list rather than every code the service accepts: the room is read in the
 * language its viewers write in, so the useful choices are the ones a mixed live
 * actually sees. Each code here has a matching entry in `speech.rs`, and the two
 * lists are only ever changed together.
 */
export const TTS_LANGUAGES: readonly TtsLanguage[] = [
  { value: 'id', label: 'Indonesian', sample: 'Halo, selamat datang di live.' },
  { value: 'en', label: 'English', sample: 'Hello, and welcome to the live.' },
  { value: 'ms', label: 'Malay', sample: 'Hai, selamat datang di live.' },
  { value: 'th', label: 'Thai', sample: 'สวัสดี ยินดีต้อนรับเข้าสู่ไลฟ์' },
  { value: 'vi', label: 'Vietnamese', sample: 'Xin chào, chào mừng đến với buổi phát trực tiếp.' },
  { value: 'zh-CN', label: 'Chinese', sample: '你好，欢迎来到直播间。' },
  { value: 'ja', label: 'Japanese', sample: 'こんにちは、ライブへようこそ。' },
  { value: 'es', label: 'Spanish', sample: 'Hola, y bienvenido a la transmisión.' },
] as const

/** The sample text for a language code, falling back to the default's. */
export function languageSample(value: string): string {
  return TTS_LANGUAGES.find((language) => language.value === value)?.sample ?? TTS_LANGUAGES[0].sample
}

export const TTS_VOLUME_MIN = 0
export const TTS_VOLUME_MAX = 1

/**
 * How loud, as a fraction the `Audio` element accepts.
 *
 * Clamped rather than trusted because it comes out of `localStorage`, which any
 * edit to — or any build that once wrote a different scale into it — can make
 * something other than a number in 0..1. `Audio.volume` throws `IndexSizeError` on
 * anything outside that, so an unchecked value is a voice that throws inside the
 * playback path, which is caught and read as "the voice service is unreachable".
 *
 * Rounded so a slider dragged at full resolution does not write a dozen settings
 * changes on the way to 100%.
 */
export function clampVolume(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : TTS_VOLUME_MAX
  return Math.round(Math.min(TTS_VOLUME_MAX, Math.max(TTS_VOLUME_MIN, number)) * 100) / 100
}

/**
 * Everything one utterance needs to know about how to sound.
 *
 * One object rather than three parameters because the three always travel together
 * — chat and gifts share a mouth — and because a fourth is coming: the
 * call sites are hooks with dependency arrays, and a fourth positional argument is
 * one more name to keep in step in three of them.
 */
export interface VoiceOptions {
  /** How fast it reads, from `TTS_PACES`. */
  pace: string
  /** The language it reads in, from `TTS_LANGUAGES`. */
  language: string
  /** How loud, 0..1. */
  volume: number
}
