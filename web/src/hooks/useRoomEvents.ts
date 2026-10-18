'use client'

import { useEffect, useRef } from 'react'
import type { OverlayEventFrame } from '@shared/events'

/**
 * A live room's frames, over the backend's overlay socket.
 *
 * The desktop app reads these from the Rust host; the web has no host, so it opens
 * the same `/ws/overlay/<room>` socket the OBS overlays do. That socket is
 * unauthenticated and read-only — it carries the room's events and nothing a caller
 * can write — so a dashboard page can listen to it without a credential.
 *
 * `backendOrigin` is the backend's HTTP origin; it is turned into a websocket one.
 * The handler is held in a ref so a caller that rebuilds it every render does not
 * tear the socket down and reconnect on each frame.
 */
export function useRoomEvents(
  backendOrigin: string,
  roomId: string,
  handler: (frame: OverlayEventFrame) => void,
): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    if (!roomId || !backendOrigin) return
    let disposed = false
    let reconnect: number | null = null

    const base = backendOrigin.replace(/\/+$/, '').replace(/^http/, 'ws')
    const url = `${base}/ws/overlay/${encodeURIComponent(roomId)}`

    function connect() {
      if (disposed) return
      const ws = new WebSocket(url)
      ws.onmessage = (event) => {
        try {
          handlerRef.current(JSON.parse(event.data) as OverlayEventFrame)
        } catch {
          // A frame that is not the JSON we expect is dropped; one bad frame must
          // not stop the next good one.
        }
      }
      ws.onclose = () => {
        if (!disposed) reconnect = window.setTimeout(connect, 3000)
      }
      ws.onerror = () => {
        try {
          ws.close()
        } catch {
          // Already closing; the onclose path owns the retry.
        }
      }
    }

    connect()
    return () => {
      disposed = true
      if (reconnect !== null) window.clearTimeout(reconnect)
    }
  }, [backendOrigin, roomId])
}
