/**
 * The one voice.
 *
 * A single place that speaks, shared by chat read-aloud and gift announcements,
 * because they are the same resource: one mouth. Two hooks each holding their own
 * `<audio>` element would talk over each other the moment a gift arrived mid
 * sentence, which is the one thing this exists to prevent.
 *
 * Every utterance goes through here, so the rules that make speech listenable are
 * written once. The rule is: **a sentence that is already speaking runs to its
 * end.** A live room sends a message every second, and a reader that cuts off
 * every second word is not reading — it is stuttering, and every sentence is
 * heard only as its first half.
 *
 * The one exception is an *urgent* utterance — a gift, a mention. Those are the
 * news, and they take the slot rather than waiting behind a sentence that is
 * still going. Everything else waits.
 *
 * Synthesis is a network round trip — the host splits a long line into pieces and
 * fetches each one — so a request made two seconds ago may only now be audible.
 * The voice is therefore claimed for the whole round trip, not just for playback:
 * an utterance that arrives mid-synthesis sees a busy voice and waits, rather
 * than being synthesised into a sentence that cuts the first one off.
 *
 * The gap between two utterances is measured from when the previous one *ended*,
 * not from when it was requested. Measuring it from the request makes the gap lie
 * about how much of the room has actually been heard.
 *
 * The voice itself is synthesised by the host — a neural voice, the one behind
 * Edge's Read Aloud — and returned as audio, because the platform's own speech
 * synthesiser is a formant synthesiser that sounds like a screen reader. Sending
 * the text to be spoken is what that quality costs, which is why both settings
 * that reach this module are opt-in.
 */

import { host } from './sidecar'
import { CHAT_TTS_GAP_MS } from './sound'

/** The utterance currently being played, so a newer one can cut it off. */
let speaking: HTMLAudioElement | null = null

/** Whether the voice is claimed — mid-sentence, or still being synthesised. */
let claimed = false

/** When the last utterance finished, so two do not begin inside the gap. */
let lastEndedAt: number | null = null

/**
 * Counts utterances asked for, so one that arrives late knows it has been
 * superseded.
 *
 * `host.speak` is a network round trip, and the slot is claimed before it
 * returns. Without this counter, `hush()` fired during that round trip paused
 * nothing — there was no audio yet — and the sentence then started playing
 * *after* the user had asked for silence. The same applied to a second `say()`
 * whose synthesis came back after a third had begun.
 */
let requested = 0

/**
 * Speaks one sentence. Ordinary utterances wait for whatever is being said;
 * urgent ones take the slot and drop it.
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
 *
 * @param pace - the reading pace, passed through to the host.
 * @param urgent - take the slot now rather than waiting. Currently unused: a gift
 * and a mention wait their turn like anything else, because the chat is what the
 * voice is primarily for.
 */
export function say(text: string, pace: string, urgent = false): void {
  const spoken = text.trim()
  if (spoken === '') return

  // The voice is busy — mid-sentence, or still being synthesised. An ordinary
  // utterance waits for it to finish: cutting it off is what turns a reader into
  // a stutter. An urgent one is the news and takes the slot.
  if (claimed) {
    if (!urgent) return
    hush()
  }

  const now = Date.now()
  // The gap is measured from the end of the last utterance, so it reflects how
  // much of the room has actually been heard rather than when a request was sent.
  if (lastEndedAt !== null && now - lastEndedAt < CHAT_TTS_GAP_MS) return

  // This one is the current request; everything already in flight is now stale.
  const ticket = (requested += 1)
  // Claimed before the round trip, so a second utterance arriving mid-synthesis
  // sees a busy voice and waits instead of being cut off by this one.
  claimed = true

  void (async () => {
    try {
      const url = await host.speak(spoken, pace)
      // A newer utterance asked for, or the voice was hushed, while this was
      // being synthesised. Either way this one is no longer wanted, and playing
      // it would be speaking over a decision the user already made.
      if (ticket !== requested || url === '') return

      const audio = new Audio(url)
      // Released when it ends so the next utterance is not measured against a
      // cut-off one, and so a stale element is never paused by mistake.
      const onEnded = () => {
        if (ticket === requested) {
          speaking = null
          claimed = false
          lastEndedAt = Date.now()
        }
        audio.removeEventListener('ended', onEnded)
      }
      audio.addEventListener('ended', onEnded)
      speaking = audio

      // One more guard before play: a newer utterance may have arrived between
      // the check above and this point. `requested` is the authority.
      if (ticket !== requested) return

      await audio.play()
    } catch {
      // The voice service is unreachable, or the browser refused to play. Either
      // way the feed keeps working, which is the part that matters — but the
      // claim has to be released, or a voice that failed once would stay silent
      // for the rest of the session.
      if (ticket === requested) {
        speaking = null
        claimed = false
      }
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
  claimed = false
  lastEndedAt = null
}
