import { useEffect, useRef } from 'react'
import { host, type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { GIFT_SOUND_GAP_MS } from '../lib/sound'

/**
 * Sends each gift to another app.
 *
 * The request goes out from the host, which is what keeps the webhook token out of
 * the page: the URL and the token are read from disk at send time, so a credential
 * travels from the config file to the socket and nowhere else. The page never holds
 * one in order to use it.
 *
 * Fire-and-forget, and that is the whole design. This fires on a gift, on the
 * busiest path in the app, and a receiver that is slow or down must not be able to
 * hold up a stream — so nothing here is awaited by the feed, and a failure is
 * silence. The one call whose result the user sees is the test button, because a URL
 * typed into a settings box has no other way to find out whether it was right.
 *
 * Gapped on the toast's interval rather than the chime's, because a gift wave arrives
 * as one frame per member and posting each one would turn a single gift into twenty
 * requests — the receiving app would see a wave as a flood.
 */

/**
 * The URL and the token are not passed in. They are read from disk by the host at
 * send time, so this hook cannot leak a credential it was never given — and a save
 * takes effect on the next gift with nothing to reload.
 */
export function useWebhook({ enabled }: { enabled: boolean }): void {
  const lastSentAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (!enabled || event.type !== 'gift') return

    const now = Date.now()
    if (lastSentAt.current !== null && now - lastSentAt.current < GIFT_SOUND_GAP_MS) return
    lastSentAt.current = now

    // Not awaited: the feed handler must not block on a network round trip to
    // somebody else's server.
    void host
      .webhookSend({
        nickname: event.nickname,
        userId: event.id,
        giftName: event.giftName,
        count: event.count ?? 1,
        diamonds: event.diamonds ?? 0,
        timestamp: now,
      })
      .catch(() => {
        // A receiver that is down is not something the stream has to know about.
      })
  }, [enabled])

  // Off: forget when the last send was, so turning it back on does not wait out a
  // gap that started while it was off.
  useEffect(() => {
    if (!enabled) lastSentAt.current = null
  }, [enabled])
}
