import { useEffect, useRef } from 'react'
import { attach, detachHandler, emitLocal, type SidecarEvent } from '../lib/sidecar'
import { greetingReply, isGreeting } from '../lib/autoreply'

/**
 * Answer a greeting so someone who says hello is not met with silence.
 *
 * Watches the chat, and when a viewer says hello the app writes one line back into
 * the feed as itself. The point is small and specific: a live room is loud, a
 * newcomer types "hi" into it, and without this their message is one of hundreds
 * scrolling past with nothing acknowledging it. With it, they get a reply.
 *
 * Rate-limited per person rather than per message. A room that says hello twenty
 * times in a minute is one person having fun, not twenty people arriving, and a bot
 * that answers each one is a bot that spams. One reply per viewer per the cooldown
 * window, keyed on the platform's stable id so a nickname change does not reset it.
 *
 * The reply is written as a normal chat row marked `isBot`, so it renders like any
 * other message and the feed marks it as the app's. It is not counted toward the
 * chat total — the app is not a viewer.
 */

interface Options {
  enabled: boolean
  /**
   * How long before the same viewer can be answered again. Long enough that a
   * repeated hello is one reply, short enough that someone who genuinely comes
   * back later is still greeted.
   */
  cooldownMs?: number
}

const DEFAULT_COOLDOWN_MS = 30_000

export function useAutoReply({ enabled, cooldownMs = DEFAULT_COOLDOWN_MS }: Options): void {
  // Keyed by viewer id: who has been answered, and when. A ref, not state — this
  // is a mutable table the handler reads and writes, and re-rendering on every
  // hello would be absurd.
  const lastRepliedAt = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (!enabled) {
      // Turning it off forgets everyone, so turning it back on does not treat the
      // whole room as recently-answered and stay silent.
      lastRepliedAt.current.clear()
      return
    }
    let active = true

    const handle = (event: SidecarEvent) => {
      if (!active || event.type !== 'chat' || event.isBot === true) return
      // The bot's own reply comes back through this same listener; ignoring bot
      // rows here is what stops it answering itself forever.
      if (!isGreeting(event.text ?? '')) return

      const now = Date.now()
      const id = event.id || event.nickname
      const last = lastRepliedAt.current.get(id)
      if (last !== undefined && now - last < cooldownMs) return
      lastRepliedAt.current.set(id, now)

      // Synchronous, same listener path a real frame takes, so the reply lands in
      // the same tick and reads as an answer rather than a separate event.
      emitLocal({
        platform: 'tiktok',
        type: 'chat',
        nickname: 'Auto-reply',
        id: 'autoreply',
        avatar: '',
        text: greetingReply(),
        timestamp: now,
        isBot: true,
      })
    }

    attach(handle)
    return () => {
      active = false
      detachHandler(handle)
    }
  }, [enabled, cooldownMs])

  // Pruned so the table does not grow unbounded over a long stream: an entry older
  // than the cooldown is already free to reply again, so holding it changes nothing.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, at] of lastRepliedAt.current) {
        if (now - at >= cooldownMs) lastRepliedAt.current.delete(id)
      }
    }, cooldownMs)
    return () => clearInterval(timer)
  }, [enabled, cooldownMs])
}
