import { useEffect, useRef } from 'react'
import { host, type LogLevel } from '../lib/sidecar'
import { describeVerdict, MODERATION_INTERVAL_MS, numberedLines, pendingModeration, type ModerationMode } from '../lib/ai'
import type { FeedItem, ModerationMark } from '../types'

export interface UseModerationOptions {
  /** Off, flag or block. Anything but `off` starts the pass. */
  mode: ModerationMode
  /** The streamer's own rules, in their words. Empty means the defaults. */
  rules: string
  items: FeedItem[]
  remove: (keys: ReadonlySet<string>) => void
  mark: (entries: readonly { key: string; moderation: ModerationMark }[]) => void
  log: (level: LogLevel, message: string) => void
}

/**
 * Reading the chat for messages worth acting on.
 *
 * A timer that sends a batch every few seconds and applies whatever comes back.
 * Nothing renders, nothing is awaited by the feed, and a model that is slow,
 * wrong or down changes nothing about what the user already sees — which is the
 * point of keeping it here rather than in the event path.
 *
 * Two things make it survivable in a busy room. A row is recorded as decided the
 * first time it is looked at, so it is judged once and never re-sent; and only
 * one pass is in flight at a time, so a provider that takes longer than the
 * interval leaves a queue building rather than a pile of requests racing.
 */
export function useModeration({ mode, rules, items, remove, mark, log }: UseModerationOptions): void {
  // Everything below is read inside a timer that must not be rebuilt when the feed
  // changes, because tearing that timer down and back up on every message would
  // mean a pass never got to run in a busy room at all. Held in refs for the same
  // reason `useChat` holds its handler.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const rulesRef = useRef(rules)
  rulesRef.current = rules
  const removeRef = useRef(remove)
  removeRef.current = remove
  const markRef = useRef(mark)
  markRef.current = mark
  const logRef = useRef(log)
  logRef.current = log
  // Read inside the pass rather than closed over, so a mode changed while a
  // request is in flight is applied to the answer that request brings back
  // rather than to the mode that started it.
  const modeRef = useRef(mode)
  modeRef.current = mode

  /** Keys already looked at. The reason a message is judged exactly once. */
  const decided = useRef(new Set<string>())
  /** One pass at a time. */
  const busy = useRef(false)

  // Turning it off has to undo the bookkeeping, not just stop the timer: the keys
  // belong to a room the streamer has decided to stop sending anywhere, and a
  // second room full of rows with the same keys would silently skip moderation.
  useEffect(() => {
    if (mode === 'off') decided.current.clear()
  }, [mode])

  useEffect(() => {
    if (mode === 'off') return
    let cancelled = false

    async function pass() {
      if (busy.current) return

      // Keys for rows the feed has since dropped. Without this the set grows for
      // the whole session, and the cap means most of what it holds is gone.
      const live = new Set(itemsRef.current.map((item) => item.key))
      for (const key of decided.current) {
        if (!live.has(key)) decided.current.delete(key)
      }

      const batch = pendingModeration(itemsRef.current, decided.current)
      if (batch.length === 0) return

      const { lines, keys } = numberedLines(batch)
      if (lines.length === 0) return

      busy.current = true
      try {
        const verdicts = await host.llmModerate(lines, rulesRef.current)
        if (cancelled) return

        for (const verdict of verdicts) {
          const key = keys[verdict.index]
          // The host has already dropped out-of-range indices. Checked again here
          // because this is the side that acts on one: an undefined key must
          // remove or mark nothing rather than whichever row happens to be at that
          // position in an array.
          if (key === undefined) continue
          const item = batch[verdict.index]
          if (!item) continue

          if (modeRef.current === 'block') {
            removeRef.current(new Set([key]))
            logRef.current('warn', `blocked ${describeVerdict(verdict, item)}`)
          } else {
            markRef.current([{ key, moderation: { label: verdict.label, reason: verdict.reason } }])
            logRef.current('info', `flagged ${describeVerdict(verdict, item)}`)
          }
        }
      } catch (error: unknown) {
        // Worth saying out loud: "moderation is on" and "moderation is working" are
        // different claims, and a silent failure is how the second one stops being
        // true without anyone noticing.
        if (!cancelled) logRef.current('warn', `moderation pass failed: ${message(error)}`)
      } finally {
        // Recorded either way. A failed pass would otherwise re-send the same
        // messages every interval, which is both the expensive reading and the one
        // that turns a broken endpoint into a loop the user cannot see.
        for (const key of keys) decided.current.add(key)
        busy.current = false
      }
    }

    // Straight into the first pass rather than waiting out the interval: the whole
    // reason this is on is the backlog of unjudged messages already on screen.
    void pass()
    const timer = window.setInterval(() => void pass(), MODERATION_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [mode])
}

/** Whatever the rejection was, as one line worth showing. */
function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}