'use client'

/**
 * Watching one room's connection until it settles.
 *
 * Connecting is asynchronous on the backend: `_connect_room` installs the adapter,
 * starts its connect loop in the background and returns immediately, so the answer
 * to a Connect says `connecting` and the room does not become live until a handshake
 * lands some time later.
 *
 * That is why this exists. Both the stream list and a stream's own page poll on a
 * fifteen-second beat, which is right for noticing a room that quietly stopped and
 * far too slow for the seconds after somebody pressed Connect. Without this, a card
 * that had just connected sat on a reading taken while the adapter was still
 * dialling — long enough that the only way to see the truth was to reload the page.
 *
 * It is a hook rather than a helper because the two callers each own a room's status
 * in a different shape — the list holds a map of every room on the page, a stream's
 * own page holds just the one — and each needs a page-scoped "am I still mounted"
 * flag. So it is handed a way to publish one reading rather than a state setter it
 * would have to guess the shape of. It was a function on the list first, and a copy
 * here would have been the second definition of when a connection is finished — which
 * is how "it says connecting but it is live" happens.
 */

import { useCallback, useEffect, useRef } from 'react'
import { api } from './client'
import type { RoomStatus } from './types'
import { useToast } from '@/components/Toast'

/** The beat, and how long to keep at it. */
const WATCH_MS = 1000
const WATCH_WINDOW_MS = 20_000

/**
 * @param publish Where a reading goes. The list merges it into its map by room id;
 *   a stream's own page replaces the single status it holds.
 */
export function useConnectionWatch(publish: (roomId: string, status: RoomStatus) => void) {
  const toast = useToast()
  // Whether the page is still mounted, so a loop started by a Connect cannot write
  // into a state setter belonging to a page that has gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  return useCallback(
    async (roomId: string, handle: string) => {
      const giveUpAt = Date.now() + WATCH_WINDOW_MS
      while (mounted.current && Date.now() < giveUpAt) {
        try {
          const status = await api.status(roomId)
          if (!mounted.current) return
          publish(roomId, status)
          // Only a handshake genuinely in flight is worth waiting through.
          // `waiting` carries `connecting` too — the backend sets both while it
          // polls for a streamer who is not live — and that wait can run for two
          // hours, so waiting on it here would be a twenty-second loop that changes
          // nothing.
          if (!status.connecting || status.waiting) {
            // The connection either landed or never will, and the operator is owed
            // the answer rather than a badge they have to go and read.
            toast(
              status.connected
                ? `@${handle} is live.`
                : status.liveEnded
                  ? `@${handle} is not live right now.`
                  : status.connecting
                    ? `@${handle} is not live — StreamKit is waiting for it.`
                    : `@${handle} is not live — StreamKit stopped trying.`,
            )
            return
          }
        } catch {
          // Not evidence about the room. The page's own poll is still running and
          // will say something when it can.
        }
        await new Promise((resolve) => window.setTimeout(resolve, WATCH_MS))
      }
    },
    [publish, toast],
  )
}
