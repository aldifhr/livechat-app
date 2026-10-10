/**
 * What an OpenAI-compatible endpoint is, and how a typed one is read.
 *
 * Pure, so the fiddly parts — a URL pasted without a scheme, a saved model the
 * endpoint has stopped offering, which messages are worth sending to a model — are
 * checked without a network or a window. All three of those look trivial and none
 * of them are: the first fails as a connection error rather than a typo, the
 * second silently drops the user's selection, and the third decides whether an
 * answer is about the room at all.
 */

import type { FeedItem } from '../types'


/** The three fields the host stores. Mirrors `LlmConfig` in src-tauri/src/llm.rs. */
export interface LlmConfig {
  /** Host and path, including the version segment: `https://host/v1`. */
  baseUrl: string
  apiKey: string
  model: string
}

export const EMPTY_CONFIG: LlmConfig = { baseUrl: '', apiKey: '', model: '' }

/** Shown when nothing is configured yet. Not applied to anything. */
export const EXAMPLE_BASE_URL = 'https://your-endpoint.example/v1'

/**
 * A base URL as typed, made into one that can be requested.
 *
 * The scheme is added when it is missing because the common case is a bare
 * `host:port/v1` copied off a terminal, and an endpoint reached that way fails
 * as "could not connect" rather than as the typo it actually is. Trailing
 * slashes come off because the host joins the path itself and a doubled slash
 * is a 404 on some proxies and a redirect on others.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/** Whether there is enough filled in to be worth spending a request on. */
export function isReady(config: LlmConfig): boolean {
  return normaliseBaseUrl(config.baseUrl) !== '' && config.apiKey.trim() !== ''
}

/**
 * The models to offer, with the saved one always among them.
 *
 * A provider can retire a model between one launch and the next. Dropping it
 * from the list would leave the user's saved selection showing as unset with no
 * explanation, so it is offered anyway — it is still what the app will use.
 */
export function modelOptions(models: string[], current: string): string[] {
  const chosen = current.trim()
  const unique = [...new Set(models.map((m) => m.trim()).filter(Boolean))].sort()
  if (chosen === '' || unique.includes(chosen)) return unique
  return [chosen, ...unique]
}

/**
 * How many messages of context ride along with a question.
 *
 * A number rather than a token count because there is no tokenizer to count with:
 * every provider here counts differently, and a limit in messages is one the app
 * can state plainly in the UI. Sixty is about the point where a busy room's
 * recent history stops being what the question was about and starts being the
 * whole session.
 */
export const CONTEXT_MESSAGES = 60

/**
 * The chat excerpt a question is answered from.
 *
 * Chat rows only. Joins and likes are not conversation, and a gift is worth one
 * line of its own rather than being dropped — but a viewer spamming an emoji is
 * not, so anything that is only an emote goes.
 *
 * The tail, because a live question is about now: the hundredth message back is
 * already a different conversation, and it is what pushes the relevant lines out
 * of the limit.
 */
export function chatContext(items: FeedItem[], limit = CONTEXT_MESSAGES): string[] {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind !== 'chat') continue
    const text = (item.text ?? '').trim()
    if (text === '') continue
    // `x3` rather than three copies: the repetition is what makes a message
    // notable, and repeating it in full would spend the limit saying it again.
    const times = (item.repeatCount ?? 1) > 1 ? ` x${item.repeatCount}` : ''
    lines.push(`${item.nickname}: ${text}${times}`)
  }
  // Not `slice(-limit)`: `-0` is `0`, so a limit of zero would slice from the
  // start and send the entire room, which is the one thing a limit of zero is
  // supposed to prevent.
  if (limit <= 0) return []
  return lines.slice(-limit)
}
