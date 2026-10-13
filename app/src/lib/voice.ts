/**
 * The one voice.
 *
 * A single place that speaks, shared by chat read-aloud and gift announcements,
 * because they are the same resource: one mouth. Two hooks each holding their own
 * `<audio>` element would talk over each other the moment a gift arrived mid
 * sentence, which is the one thing this exists to prevent.
 *
 * Every utterance goes through here, so the rules that make speech listenable are
 * written once: cut off whatever is being said rather than queueing behind it, and
 * refuse to start a second one inside the gap. A live room does not wait, and a
 * queue of half-finished sentences is worse than dropping one.
 *
 * The voice itself is synthesised by the host — a neural voice, the one behind
 * Edge's Read Aloud — and returned as audio, because the platform's own speech
 * synthesiser is a formant synthesiser that sounds like a screen reader. Sending
 * the text to be spoken is what that quality costs, which is why both settings
 * that reach this module are opt-in.
 */

import { host } from './sidecar'
import { CHAT_TTS_GAP_MS } from './sound'

/** The utterance currently being spoken, so a newer one can cut it off. */
let speaking: HTMLAudioElement | null = null

/** When the last utterance started, so two do not begin inside the gap. */
let lastSpokeAt: number | null = null

/**
 * Counts utterances asked for, so one that arrives late knows it has been
 * superseded.
 *
 * `host.speak` is a network round trip, and everything above is decided before it
 * returns. Without this, `hush()` fired during that round trip paused nothing —
 * there was no audio yet — and the sentence then started playing *after* the user
 * had asked for silence. The same applied to a second `say()` whose synthesis came
 * back after a third had begun.
 */
let requested = 0

/**
 * Speaks one sentence, cutting off whatever is already being said.
 *
 * Fire-and-forget: the caller does not wait for the audio, because the feed
 * handler that calls this must not block on a network round trip. A failure is
 * silence, not an exception — a chat reader that stops reading because a voice
 * failed is worse than one that keeps going quietly.
 *
 * The pace is a parameter rather than a constant because it is a setting, and a
 * setting someone changed has to reach the host that will honour it. An
 * unrecognised value is passed on as it is: the host checks it against the paces
 * it has and settles for its default, which keeps a stale saved setting from
 * silencing the chat.
 */
export function say(text: string, pace: string): void {
  const spoken = text.trim()
  if (spoken === '') return

  const now = Date.now()
  if (lastSpokeAt !== null && now - lastSpokeAt < CHAT_TTS_GAP_MS) return
  lastSpokeAt = now

  // This one is the current request; everything already in flight is now stale.
  const ticket = (requested += 1)

  // Cut off the current sentence rather than waiting for it to finish. Two
  // sentences at once is worse than one of them being dropped.
  if (speaking) {
    speaking.pause()
    speaking = null
  }

  void (async () => {
    try {
      const url = await host.speak(spoken, pace)
      // A newer utterance asked for, or the voice was hushed, while this was
      // being synthesised. Either way this one is no longer wanted, and playing
      // it would be speaking over a decision the user already made.
      if (ticket !== requested || url === '') return
      const audio = new Audio(url)
      speaking = audio
      // Released when it ends so the next utterance is not measured against a
      // cut-off one, and so a stale element is never paused by mistake.
      const onEnded = () => {
        if (speaking === audio) speaking = null
        audio.removeEventListener('ended', onEnded)
      }
      audio.addEventListener('ended', onEnded)
      await audio.play()
    } catch {
      // The voice service is unreachable, or the browser refused to play. Either
      // way the feed keeps working, which is the part that matters.
    }
  })()
}

/** Stops whatever is being said and forgets the gap. */
export function hush(): void {
  // Anything already being synthesised is cancelled before it can start, which
  // is what stops an in-flight request from speaking over the silence.
  requested += 1
  if (speaking) {
    // The source is cleared as well as paused: the element holds the whole
    // synthesised clip, and leaving it referenced keeps that base64 alive.
    speaking.pause()
    speaking.removeAttribute('src')
    speaking = null
  }
  lastSpokeAt = null
}
