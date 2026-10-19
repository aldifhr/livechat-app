/**
 * The one voice.
 *
 * A single place that speaks, shared by chat read-aloud and gift announcements,
 * because they are the same resource: one mouth. Two hooks each holding
 * their own `<audio>` element would talk over each other the moment a gift arrived
 * mid-sentence, which is the one thing this exists to prevent.
 *
 * Every utterance goes through here, so the rules that make speech listenable are
 * written once. The rule is: **a sentence that is already speaking runs to its
 * end.** A live room sends a message every second, so a reader needs a queue:
 * cutting off the current sentence or dropping the next one makes it stutter.
 *
 * The one exception used to be an *urgent* utterance — a gift — which
 * took the slot rather than waiting. That is gone: no caller ever passed it, and
 * the gift hook was written to wait on purpose (a gift that cuts
 * off the reader mid-sentence is worse than one that arrives a beat later). A
 * parameter whose only correct value is "never" is a trap for the next reader, so
 * `hush()` is now the only way an ordinary utterance is cut off.
 *
 * Synthesis is a network round trip — the host splits a long line into pieces and
 * fetches each one — so a request made two seconds ago may only now be audible.
 * The voice is therefore claimed for the whole round trip, not just for playback:
 * an utterance that arrives mid-synthesis waits in arrival order rather than
 * being dropped or synthesised into a sentence that cuts the first one off.
 *
 * The gap between two utterances is measured from when the previous one *ended*,
 * not from when it was requested. Measuring it from the request makes the gap lie
 * about how much of the room has actually been heard.
 *
 * Volume is applied here rather than in the host, and for the reason the audio
 * comes back at all: the page owns the one `Audio` element every other sound goes
 * through, so a voice played in the host would sit at its own loudness, on its own
 * clock, unable to be silenced by the same control as the rest.
 *
 * The voice itself is synthesised by the host — a neural voice — and returned as
 * audio, because the platform's own speech synthesiser is a formant synthesiser
 * that sounds like a screen reader. Sending the text to be spoken is what that
 * quality costs, which is why every setting that reaches this module is opt-in.
 */

import { host } from './sidecar'
import { CHAT_TTS_GAP_MS } from './sound'
import { clampVolume, type VoiceOptions } from './voices'

/** The utterance currently being played, so a newer one can cut it off. */
let speaking: HTMLAudioElement | null = null

/** Whether the voice is claimed — mid-sentence, or still being synthesised. */
let claimed = false

/** When the last utterance finished, so two do not begin inside the gap. */
let lastEndedAt: number | null = null

type SpeechChannel = 'chat' | 'event' | 'preview'
interface SpeechRequest {
  text: string
  options: VoiceOptions
  channel: SpeechChannel
}

/** Spoken in arrival order, so a busy voice never silently discards a message. */
const queue: SpeechRequest[] = []
let queueTimer: ReturnType<typeof setTimeout> | null = null
let activeChannel: SpeechChannel | null = null

/**
 * Counts active utterances, so a late audio event from an older line cannot
 * release the claim held by a newer line.
 *
 * `host.speak` is a network round trip, and the slot is claimed before it
 * returns. Without this counter, `hush()` fired during that round trip paused
 * nothing — there was no audio yet — and the sentence then started playing
 * *after* the user had asked for silence.
 */
let requested = 0

/**
 * Speaks one sentence. Fire-and-forget: the caller does not wait for the audio,
 * because the feed handler that calls this must not block on a network round trip.
 * A failure is silence, not an exception — a chat reader that stops reading because
 * a voice failed is worse than one that keeps going quietly.
 *
 * The options are passed through rather than resolved here because the page knows
 * what the user picked and the host knows what the service honours: an unrecognised
 * pace or language is the host's to settle for its default, which keeps a stale
 * saved setting from silencing the chat.
 *
 * @param options - pace, language and volume for this utterance.
 */
export function say(text: string, options: VoiceOptions, channel: SpeechChannel = 'event'): void {
  const spoken = text.trim()
  if (spoken === '') return
  queue.push({ text: spoken, options, channel })
  pump()
}

/** Start the next queued line after the current audio and short natural pause. */
function pump(): void {
  if (claimed || queueTimer !== null || queue.length === 0) return

  const pause = lastEndedAt === null
    ? 0
    : Math.max(0, CHAT_TTS_GAP_MS - (Date.now() - lastEndedAt))
  if (pause > 0) {
    queueTimer = setTimeout(() => {
      queueTimer = null
      pump()
    }, pause)
    return
  }

  const next = queue.shift()
  if (!next) return

  // Each utterance gets its own ticket. A late event from an older audio element
  // can therefore never release the claim held by a newer line.
  const ticket = (requested += 1)
  claimed = true
  activeChannel = next.channel
  void speak(next.text, next.options, ticket).catch(() => release(ticket))
}

/**
 * Speaks a sample with the current settings, and reports whether it worked.
 *
 * The one path that talks over what is already playing, and the only one that
 * ignores the gap: both exist for the same reason. A tester click is a request to
 * hear the voice *now* — obeying either rule here would make the button silently do
 * nothing whenever a sentence happened to be in flight or had just ended, and a
 * control that does nothing when pressed is the one failure a settings dialog
 * cannot have. It costs the reader its place, which is acceptable from someone
 * standing in settings with the room still quiet.
 *
 * Rejects rather than returning a flag, so the caller cannot forget to check it —
 * a preview that reported "done" when the voice service was unreachable would be
 * exactly the voice setting that quietly does nothing.
 */
export async function preview(text: string, options: VoiceOptions): Promise<void> {
  const spoken = text.trim()
  if (spoken === '') throw new Error('nothing to say')

  hush()
  const ticket = (requested += 1)
  claimed = true
  activeChannel = 'preview'
  try {
    const played = await speak(spoken, options, ticket)
    // Hushed or superseded while it was being synthesised. Reporting success here
    // would claim a sentence was heard that never was.
    if (!played) throw new Error('stopped before it played')
  } catch (error: unknown) {
    release(ticket)
    throw error
  }
}

/**
 * Fetches the audio and plays it, returning whether anything was actually played.
 *
 * A `false` means the utterance was hushed while it was being synthesised, which
 * is not a failure of the voice service and not something the ordinary reader needs
 * to hear about. An empty answer and a rejection are both failures and both
 * throw, because both leave the user hearing nothing and neither is worth
 * distinguishing from inside here.
 */
async function speak(text: string, options: VoiceOptions, ticket: number): Promise<boolean> {
  const url = await host.speak(text, options.pace, options.language)
  // A newer utterance asked for, or the voice was hushed, while this was being
  // synthesised. Either way this one is no longer wanted, and playing it would be
  // speaking over a decision the user already made.
  if (ticket !== requested) return false
  if (url === '') {
    // The host had no audio for this text. That is not "say it later" — it is
    // nothing to play — and the claim has to come back, or a voice that returned
    // empty once stays claimed forever and every later `say()` returns at the busy
    // check above. That is a silent reader for the rest of the session, which is
    // exactly the failure the catch on `say()` guards against.
    throw new Error('the voice service returned no audio for that text')
  }

  const audio = new Audio(url)
  // Clamped here rather than where it is set: the saved value is attacker-free but
  // not corruption-free, and `Audio.volume` throws on anything outside 0..1 — inside
  // the playback path, where the rejection reads as an unreachable voice service.
  audio.volume = clampVolume(options.volume)
  // Released when it ends so the next utterance is not measured against a
  // cut-off one, and so a stale element is never paused by mistake.
  let onEnded: () => void = () => {}
  let onError: () => void = () => {}
  const finish = (played: boolean) => {
    if (ticket === requested) {
      speaking = null
      claimed = false
      activeChannel = null
      lastEndedAt = played ? Date.now() : null
      pump()
    }
    audio.removeEventListener('ended', onEnded)
    audio.removeEventListener('error', onError)
  }
  onEnded = () => finish(true)
  onError = () => finish(false)
  audio.addEventListener('ended', onEnded)
  audio.addEventListener('error', onError)
  speaking = audio

  // One more guard before play: a newer utterance may have arrived between the check
  // above and this point. `requested` is the authority.
  if (ticket !== requested) return false

  await audio.play()
  return true
}

/**
 * Gives the voice back after something went wrong.
 *
 * The ticket check is the point: a synthesis that failed *after* a newer one
 * started must not release the newer one's claim, or the voice the user is
 * currently hearing would be handed to whatever message arrives next — two at once.
 */
function release(ticket: number): void {
  if (ticket !== requested) return
  speaking = null
  claimed = false
  activeChannel = null
  lastEndedAt = null
  pump()
}

/** Stop speech, or clear only one source while preserving the other source's queue. */
export function hush(channel?: SpeechChannel): void {
  if (channel) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].channel === channel) queue.splice(index, 1)
    }
    if (activeChannel === channel) {
      requested += 1
      if (speaking) {
        speaking.pause()
        speaking.removeAttribute('src')
        speaking = null
      }
      claimed = false
      activeChannel = null
      lastEndedAt = null
    }
    if (queue.length === 0 && queueTimer !== null) {
      clearTimeout(queueTimer)
      queueTimer = null
    }
    pump()
    return
  }

  queue.length = 0
  if (queueTimer !== null) {
    clearTimeout(queueTimer)
    queueTimer = null
  }
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
  activeChannel = null
  lastEndedAt = null
}
