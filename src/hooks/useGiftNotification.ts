import { useEffect, useRef } from 'react'
import { attach, detachHandler, host, type SidecarEvent } from '../lib/sidecar'
import { noticeText, shouldShowGiftNotice } from '../lib/notice'

/**
 * A desktop toast on a gift.
 *
 * Mounted in the main window only, like the chime: the overlay is click-through
 * decoration, and a toast raised from there would outlive it and credit the wrong
 * window for it.
 *
 * Failure is swallowed. A notification service that is off, blocked, or mid-update
 * must not be able to take the feed down with it — the same reasoning as the room
 * status line admitting when it does not know what is going on.
 */
export function useGiftNotification(enabled: boolean): void {
  const lastShownAt = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    const handle = (event: SidecarEvent) => {
      if (!active || event.type !== 'gift') return
      if (event.platform !== 'tiktok') return

      const now = Date.now()
      if (!shouldShowGiftNotice(enabled, lastShownAt.current, now)) return
      lastShownAt.current = now

      const { title, body } = noticeText(event.nickname, event.giftName, event.count ?? 1, event.diamonds ?? 0)
      host.notify(title, body).catch(() => {
        // Windows declines toasts when the app has no registered shortcut, and a
        // declined toast is not something the user can act on.
      })
    }

    attach(handle)
    return () => {
      active = false
      detachHandler(handle)
    }
  }, [enabled])

  // Silence forgets when the last toast was, so turning it back on does not wait
  // out a gap that started while it was off.
  useEffect(() => {
    if (!enabled) lastShownAt.current = null
  }, [enabled])
}