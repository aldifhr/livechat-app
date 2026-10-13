/**
 * What the app sounds like.
 *
 * Synthesised rather than played from a file: an app that has to ship a binary
 * for one chime is worse than one that makes the chime, and a synthesised one is
 * still silent until the user has interacted with the app — which is exactly the
 * autoplay rule a live chat app should live under anyway.
 */

/**
 * Shortest gap between two gift sounds.
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
const GIFT_BASE_HZ = 659.25

/**
 * Whether an event arriving now is worth hearing.
 *
 * One function for every sound the app makes, because it is the same decision
 * with a different number: the only thing a gap does is answer "was the last one
 * recent enough that this would be part of it", and that question has three
 * answers that differ only by a constant. Each event keeps its own name and its
 * own default below, because the number is the part worth reading off the
 * settings rather than re-deriving at the call site.
 *
 * `lastPlayedAt` is null before anything has played this session, and that case
 * is deliberately always allowed: the first gift in a quiet room is the whole
 * point of the feature, and a gap measured from the start of time would let it
 * through by accident rather than by decision.
 */
export function shouldPlaySound(
  enabled: boolean,
  lastPlayedAt: number | null,
  now: number,
  gapMs: number,
): boolean {
  if (!enabled) return false
  if (lastPlayedAt === null) return true
  return now - lastPlayedAt >= gapMs
}

/** Whether a gift arriving now is worth hearing. */
export function shouldPlayGiftSound(
  enabled: boolean,
  lastPlayedAt: number | null,
  now: number,
  gapMs: number = GIFT_SOUND_GAP_MS,
): boolean {
  return shouldPlaySound(enabled, lastPlayedAt, now, gapMs)
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
  return GIFT_BASE_HZ * 2 ** steps
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

/**
 * The chat blip.
 *
 * One short note, quieter and higher than the gift chime, so it reads as "a
 * message" rather than "a gift" without the user having to look. It is a blip
 * and not a chord because chat is far more frequent than gifts — a busy room
 * would turn a two-note chime into a drone.
 */
export const CHAT_SOUND_GAIN = 0.08

/** Higher than the gift's base note, so the two never read as the same event. */
const CHAT_BASE_HZ = 880

/** Short. A chat blip that rings is a chat blip that covers the next one. */
export const CHAT_NOTE_MS = 90

export function chatBlip(): { frequency: number; gain: number; durationMs: number } {
  return { frequency: CHAT_BASE_HZ, gain: CHAT_SOUND_GAIN, durationMs: CHAT_NOTE_MS }
}

/**
 * Shortest gap between two chat blips.
 *
 * The same problem the gift gap solves, but the busier version: chat arrives
 * several a second in an active room, and a blip per message is a buzz rather
 * than a signal. Half a second is about the point where separate messages are
 * still heard as separate taps.
 */
export const CHAT_SOUND_GAP_MS = 500

/** Whether a chat message arriving now is worth a blip. */
export function shouldPlayChatSound(
  enabled: boolean,
  lastPlayedAt: number | null,
  now: number,
  gapMs: number = CHAT_SOUND_GAP_MS,
): boolean {
  return shouldPlaySound(enabled, lastPlayedAt, now, gapMs)
}

/**
 * Shortest gap between two join sounds.
 *
 * Longer than the chat blip's, because an arrival is worth less attention than a
 * message: a room filling up is not news, and a tap for every one of them says
 * "something is happening" without ever saying what. Shorter than the gift's,
 * because the two are not the same kind of event — a gift is worth money, and a
 * join is worth a person, and the second should not have to wait four seconds for
 * the room to notice it.
 *
 * Not a correction for joins being frequent. TikTok batches its join events
 * rather than sending one per viewer, so they already arrive far apart; this is
 * here for the case where that stops being true, not to thin out a trickle.
 */
export const JOIN_SOUND_GAP_MS = 2000

/** Whether a viewer arriving now is worth a sound. */
export function shouldPlayJoinSound(
  enabled: boolean,
  lastPlayedAt: number | null,
  now: number,
  gapMs: number = JOIN_SOUND_GAP_MS,
): boolean {
  return shouldPlaySound(enabled, lastPlayedAt, now, gapMs)
}

/**
 * The mention alert.
 *
 * Two notes, and deliberately not the chat blip: a blip is something happened, a
 * mention is something happened *to you*, and they have to be told apart without
 * looking. Rising rather than level, because a rise reads as a question being
 * asked and a level tone reads as another message arriving.
 *
 * Quieter than the gift chime, which stays the loudest thing in the app — a gift
 * is worth money and a mention is worth attention.
 */
export const MENTION_GAIN = 0.13

const MENTION_LOW_HZ = 784
const MENTION_HIGH_HZ = 1047

export function mentionAlert(): { low: number; high: number; gain: number; durationMs: number } {
  return { low: MENTION_LOW_HZ, high: MENTION_HIGH_HZ, gain: MENTION_GAIN, durationMs: 130 }
}

/**
 * Shortest gap between two mention alerts.
 *
 * Longer than the chat blip's and shorter than the gift's. A mention wave — three
 * people saying your name at once — is one event, and the gap is what makes it
 * sound like one rather than like three separate demands for attention.
 */
export const MENTION_GAP_MS = 2500

/** Whether a mention arriving now is worth alerting on. */
export function shouldPlayMentionAlert(
  enabled: boolean,
  lastPlayedAt: number | null,
  now: number,
  gapMs: number = MENTION_GAP_MS,
): boolean {
  if (!enabled) return false
  if (lastPlayedAt === null) return true
  return now - lastPlayedAt >= gapMs
}

/**
 * A bracketed emote, the way TikTok writes them: `[thanks]`, `[heart]`.
 *
 * Anything inside a pair of brackets with no whitespace. Mentions are written
 * `@handle` and not `[handle]`, so there is no reading of a square bracket here
 * that is not an emote.
 */
const EMOTE = /\[[^\s[\]]+\]/g

/**
 * The text read aloud for one chat message.
 *
 * Trimmed to a length a voice can finish before the next message arrives: a
 * paragraph spoken over a live stream is a wall of overlapping speech. An
 * ellipsis marks that it was cut rather than pretending that was the whole
 * message.
 *
 * The message is spoken on its own. A sender's name used to be prefixed to it,
 * and it did not survive contact with the voice: the prefix is not what a
 * listener is tracking, the words in the message are, and a name spoken ahead of
 * every line is a second thing to follow. So the read is the chat, uninterrupted.
 *
 * Emotes are taken out before anything else, because the service reads each one
 * as a word: a message ending `[thanks]` is spoken ending in "thanks", which is
 * the single most common way a chat line reads wrong. Only the bracketed form is
 * removed. Real Unicode emoji are already silent there — measured against the
 * endpoint, a message with 🙏 in it returns byte-for-byte the same audio as one
 * without — so there is nothing to fix and stripping them would only risk eating
 * a character the message needed.
 *
 * Replaced with a space rather than nothing, so two words separated only by an
 * emote do not become one word.
 */
export const TTS_MAX_CHARS = 120

export function ttsText(text: string): string {
  // Emotes first, so the whitespace collapse below tidies the gap they leave.
  const body = text.replace(EMOTE, ' ').trim().replace(/\s+/g, ' ')
  // A message that was nothing but emotes leaves nothing to say. Speaking it would
  // put an empty utterance into the gap and hold it against the next message.
  if (body === '') return ''
  return body.length > TTS_MAX_CHARS ? `${body.slice(0, TTS_MAX_CHARS).trimEnd()}…` : body
}

/**
 * Shortest gap between two spoken messages.
 *
 * Far longer than the blip's gap, and for a different reason: speech is not a
 * tap, it is a sentence, and two spoken messages that overlap are unintelligible
 * rather than merely busy. This is a floor on the start of the next one; the
 * voice finishing the current utterance is handled separately, by cancelling it
 * only when a newer message arrives.
 */
export const CHAT_TTS_GAP_MS = 1800

/**
 * The sentence a gift is announced with.
 *
 * Reads as an announcement, not as a chat line: the name comes first, then what
 * was sent, then the value when there is one. The value is spoken as diamonds
 * rather than as a bare number, because "500" on its own does not say what was
 * counted — and a gift's worth is the reason it is being announced at all.
 *
 * The count agrees with the word. One diamond is the smallest thing anybody sends
 * and it is announced constantly, so "1 diamonds" is not a rare slip: it is the
 * most common sentence this module produces, and the one most likely to be heard.
 */
export function giftAnnouncement(nickname: string, giftName: string, count: number, diamonds: number): string {
  const who = nickname.trim() || 'Someone'
  const what = count > 1 ? `${giftName} kali ${count}` : giftName || 'a gift'
  if (diamonds <= 0) return `${who} mengirim ${what}`
  const worth = diamonds === 1 ? '1 diamond' : `${diamonds} diamonds`
  return `${who} mengirim ${what}, ${worth}`
}
