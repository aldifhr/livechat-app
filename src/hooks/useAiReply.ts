import { useEffect, useRef } from 'react'
import { host, type LogLevel } from '../lib/sidecar'
import { clampSeconds, REPLY_CONTEXT } from '../lib/ai'
import { chatContext } from '../lib/llm'
import type { FeedItem } from '../types'
import type { FeedInput } from './useFeed'

export interface UseAiReplyOptions {
  enabled: boolean
  /** Shortest gap between two of its answers. */
  seconds: number
  /** How it should behave, in the streamer's words. Empty means the defaults. */
  persona: string
  /** What the stream is, so the answer is about this room. */
  topic: string
  items: FeedItem[]
  /** Writes a row without counting it — the model is not a viewer. */
  post: (item: FeedInput) => void
  log: (level: LogLevel, message: string) => void
}

/**
 * Letting the model keep the room company.
 *
 * The same shape as the moderation pass — a timer, a request, whatever comes back
 * applied to the feed — with one difference that matters: the answer is optional,
 * and is asked for by name rather than inferred from an empty result. A model that
 * speaks every time it is offered the room is spam with a latency, and the only
 * way to get something else is to make silence the easy answer.
 *
 * So a pass only runs when the chat has actually moved since the last one. That
 * single rule is what stops the common failure: an idle room, a request every
 * interval anyway, and a bill that grows while the streamer sleeps.
 */
export function useAiReply({ enabled, seconds, persona, topic, items, post, log }: UseAiReplyOptions): void {
  // Refs for the same reason as `useModeration`, and for the same reason the timer
  // must survive a feed that changes several times a second.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const personaRef = useRef(persona)
  personaRef.current = persona
  const topicRef = useRef(topic)
  topicRef.current = topic
  const postRef = useRef(post)
  postRef.current = post
  const logRef = useRef(log)
  logRef.current = log

  /** The context last put to the model, so "has anything happened" is one compare. */
  const asked = useRef('')
  const busy = useRef(false)

  // Clamped here as well as in the field: a settings file or a future caller can
  // carry any number, and `setInterval` with zero or a negative would fire as fast
  // as the event loop allows.
  const intervalMs = clampSeconds(seconds) * 1000

  // Turning it off clears what was last asked, so turning it back on looks at the
  // room as it is now rather than skipping everything that arrived in between.
  useEffect(() => {
    if (!enabled) asked.current = ''
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    async function pass() {
      if (busy.current) return

      const context = chatContext(itemsRef.current, REPLY_CONTEXT)
      if (context.length === 0) return

      // Nothing new has been said since the last pass, so there is nothing to
      // answer and no reason to ask. Compared as one string rather than by length
      // or by timestamp: the feed's oldest rows slide out of the window on their
      // own, so a length alone would read as "changed" forever.
      const transcript = context.join('\n')
      if (transcript === asked.current) return

      busy.current = true
      try {
        const reply = await host.llmAutoReply(context, topicRef.current, personaRef.current)
        if (cancelled) return

        if (reply === null) {
          logRef.current('info', 'auto-reply: nothing worth saying')
          return
        }
        postRef.current({
          platform: 'tiktok',
          kind: 'answer',
          nickname: 'AI',
          id: 'ai',
          avatar: '',
          timestamp: Date.now(),
          text: reply,
        })
        logRef.current('info', `auto-replied: ${summarise(reply)}`)
      } catch (error: unknown) {
        if (!cancelled) logRef.current('warn', `auto-reply failed: ${message(error)}`)
      } finally {
        // Recorded either way, so a provider that is down is retried when there is
        // something new to say rather than on every tick against the same chat.
        asked.current = transcript
        busy.current = false
      }
    }

    // No immediate first pass: a model that answers the instant it is switched on
    // interrupts whatever the streamer is in the middle of reading.
    const timer = window.setInterval(() => void pass(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [enabled, intervalMs])
}

/** A reply short enough to sit in one log line, on one line. */
function summarise(reply: string): string {
  const flat = reply.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}

/** Whatever the rejection was, as one line worth showing. */
function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}