/**
 * Recognising a greeting, so the bot can answer it.
 *
 * Pure and self-contained: the rule is checked without a feed, without a name to
 * guess at, and without a hook, so what counts as "hello" is one place that can be
 * read and tested rather than a condition scattered through a listener.
 *
 * The comparison is deliberately about whole words. "hi" inside "this" or "hidden"
 * is not a greeting, and a bot that answers every word containing its trigger is a
 * bot nobody keeps on. Punctuation and case are ignored — TikTok does not send
 * "Hello." and "hello" and "HELLO!" consistently, and they are the same greeting.
 */

/**
 * The greetings the bot answers.
 *
 * English and Indonesian, because the room is Indonesian and TikTok is global and
 * the two arrive mixed. Matched on the normalised word, so "halo" and "Halo" and
 * "HALO!!!" are one greeting.
 */
const GREETINGS = new Set([
  'hello',
  'halo',
  'hai',
  'hi',
  'hey',
  'helo',
  'hallo',
  'assalamualaikum',
  'salam',
  'pagi',
  'siang',
  'sore',
  'malam',
  'oy',
  'woy',
])

/**
 * Whether the message is a greeting the bot should answer.
 *
 * True only when every word is a greeting or punctuation — "hi", "hello!",
 * "halo semua" all qualify, while "hi can you help me" does not: a greeting with a
 * question after it is a question, and answering the greeting instead of the
 * question is worse than not answering at all.
 */
export function isGreeting(text: string): boolean {
  // Lowercase, strip punctuation to spaces, collapse. A greeting is matched on
  // the words that remain, so "hello!!!" and "hello" are the same greeting.
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')

  if (words.length === 0 || words.length > 3) {
    // Empty is nothing. More than three words is a message, not a greeting —
    // "hi halo hai hey" is someone playing with the bot, not saying hello.
    return false
  }

  return words.every((w) => GREETINGS.has(w))
}

/**
 * The reply to a greeting.
 *
 * A fixed, warm line rather than something assembled per person. The point of an
 * auto-reply is that someone who says hello is not met with silence; a canned line
 * that always lands beats a clever one that sometimes does not. Kept as a function
 * so there is one place to change it and a test can pin the behaviour.
 */
export function greetingReply(): string {
  return 'Halo! Senang kamu mampir 👋'
}
