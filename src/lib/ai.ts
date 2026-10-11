/**
 * What the model does with a room while nobody is watching it.
 *
 * Two jobs, one endpoint: it reads the chat to decide what is worth acting on,
 * and it reads the chat to decide whether to say something. Both are cheap to get
 * wrong in ways a screenshot would not show — a message re-sent forever because
 * nothing recorded that it was already checked, a reply posted as empty text, an
 * index that names the wrong row — so the decisions live here as plain functions
 * and are checked without a network, a window, or a clock.
 *
 * The wire formats live in src-tauri/src/llm.rs, which is where the answers are
 * parsed. What arrives back is already narrowed: indices are in range and a
 * verdict always has a label.
 */

import type { FeedItem, RoomState } from '../types'

/**
 * What to do with a message the model flags.
 *
 * `flag` and `block` are different promises, not different strengths of the same
 * one. Flagging says "you decide": the row stays, marked, and the streamer acts.
 * Blocking says "already decided": the row is gone and only the log records it.
 * `off` exists so the stored setting has somewhere to say nothing rather than
 * defaulting to whichever mode happens to be first.
 */
export type ModerationMode = 'off' | 'flag' | 'block'

/** The three modes, in the order the dropdown reads. */
export const MODERATION_MODES: { id: ModerationMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Nothing is sent to the model' },
  { id: 'flag', label: 'Flag', hint: 'Messages stay, marked with the reason' },
  { id: 'block', label: 'Block', hint: 'Messages are removed from the feed' },
]

/** Whether a mode does anything at all. */
export function isModerating(mode: ModerationMode): boolean {
  return mode !== 'off'
}

/**
 * A mode a settings file might hold, resolved.
 *
 * Same job as `resolveTheme`: a build that renames or drops a mode would otherwise
 * reach the selector as a value nothing answers to, leaving the dropdown blank
 * and the feature silently off. Anything unrecognised is treated as off, because
 * the alternative — guessing at a mode the user did not pick — would start sending
 * their chat somewhere they did not agree to.
 */
export function resolveModeration(saved: unknown): ModerationMode {
  const found = MODERATION_MODES.find((mode) => mode.id === saved)
  return found ? found.id : 'off'
}

/** One flagged message, as the host returns it. */
export interface ModerationVerdict {
  /** Which message of the batch, counted from zero. Always within the batch. */
  index: number
  label: string
  reason: string
}

/**
 * How many messages go out in one moderation request.
 *
 * A cap rather than a rule about which messages to send: the answer comes back as
 * positions in the batch, so a batch is the unit the two sides agree on, and a
 * larger one is a longer prompt to pay for on every pass. Twenty-five covers a
 * room several times busier than most between two passes.
 */
export const MODERATION_BATCH = 25

/**
 * How often the moderation pass runs.
 *
 * A timer rather than a per-message trigger, for the obvious reason: a model call
 * per message costs a hundred times what a call per batch does, and in a busy
 * room would not keep up anyway. Five seconds is short enough that a message is
 * marked while it is still on screen, and long enough that a slow provider is not
 * asked for a second request while the first is still in flight.
 */
export const MODERATION_INTERVAL_MS = 5000

/**
 * The messages a pass should send.
 *
 * Chat rows only, with words in them: a join is not something to moderate and an
 * emote-only message has nothing for a model to judge. Anything already decided
 * is skipped — that set is what stops the same message being re-sent on every
 * pass — and so is anything TikTok filtered itself, which has already been dealt
 * with by the platform and is usually a duplicate of something else.
 *
 * The tail, and capped. A busy room produces more in one pass than a prompt
 * should carry, and a message that ages out of the batch is one nobody will look
 * at again: the window the model was asked about has moved on.
 */
export function pendingModeration(items: FeedItem[], decided: ReadonlySet<string>): FeedItem[] {
  const batch: FeedItem[] = []
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]
    if (item.kind !== 'chat') continue
    if (item.moderation) continue
    if (item.isFiltered) continue
    if (decided.has(item.key)) continue
    if ((item.text ?? '').trim() === '') continue
    batch.push(item)
    if (batch.length >= MODERATION_BATCH) break
  }
  return batch.reverse()
}

/**
 * The wire form of a batch: numbered lines, and the keys they stand for.
 *
 * Both halves are returned together because they cannot be kept in step
 * otherwise. The keys are what the verdicts are mapped back onto, and a batch
 * whose mapping is reconstructed from the items later is a batch mapped from the
 * wrong order the moment the feed changes underneath it.
 *
 * Numbered from one, matching what the prompt shows the model, and a line is
 * `<n>: <nickname>: <text>` so the two colons cannot be confused for a nickname
 * that contains one.
 */
export function numberedLines(batch: FeedItem[]): { lines: string[]; keys: string[] } {
  const lines: string[] = []
  const keys: string[] = []
  batch.forEach((item, at) => {
    const text = (item.text ?? '').trim()
    if (text === '') return
    lines.push(`${at + 1}: ${item.nickname}: ${text}`)
    keys.push(item.key)
  })
  return { lines, keys }
}

/**
 * One flagged message, as a line worth reading in the log.
 *
 * The nickname is in it because the log's job is to let a streamer go back and
 * find the message, and "blocked a message about links" does not tell them which
 * one of forty it was. The reason is omitted when the model gave none rather than
 * trailing an empty pair of brackets.
 */
export function describeVerdict(verdict: ModerationVerdict, item: FeedItem): string {
  const name = item.nickname.trim() === '' ? 'someone' : item.nickname.trim()
  const reason = verdict.reason.trim()
  return reason === '' ? `${name}: ${verdict.label}` : `${name}: ${verdict.label} — ${reason}`
}

/** How many chat lines an auto-reply is answered from. */
export const REPLY_CONTEXT = 30

/**
 * The bounds on the gap between two of the model's own answers.
 *
 * A floor rather than a schedule: the model is told it may stay quiet, so this is
 * the fastest it is *allowed* to speak, not how often it will. Twenty seconds is
 * about the point where a second answer stops being a reply and starts being an
 * interruption, and ten minutes is long enough that a streamer who turns it on and
 * goes to lunch still finds the room alive.
 */
export const REPLY_MIN_SECONDS = 20
export const REPLY_MAX_SECONDS = 600

/**
 * Seconds a field said, as seconds worth running on.
 *
 * A stored value is clamped rather than trusted, and so is a number the field is
 * still being typed into: zero would mean a request per tick and negative would
 * mean a timer that never fires at all. A field mid-edit passes through `NaN`,
 * and `Math.min`/`Math.max` hand that straight back — which would put `NaN` into
 * `setTimeout` and stop the feature for the rest of the session over a keystroke.
 */
export function clampSeconds(value: number): number {
  if (!Number.isFinite(value)) return REPLY_MIN_SECONDS
  return Math.min(REPLY_MAX_SECONDS, Math.max(REPLY_MIN_SECONDS, Math.round(value)))
}

/**
 * What the stream is, in a line the model can read.
 *
 * The title alone is not much, and neither is a bare handle: what a viewer is
 * asking about is usually the thing on screen, and the streamer names that in the
 * title. Both, joined, because the prompt reads better with both than with
 * whichever happened to be set.
 */
export function streamTopic(room: Pick<RoomState, 'target' | 'title'>): string {
  const target = room.target.trim()
  const title = room.title.trim()
  if (target !== '' && title !== '') return `@${target} — ${title}`
  if (target !== '') return `@${target}`
  return title
}