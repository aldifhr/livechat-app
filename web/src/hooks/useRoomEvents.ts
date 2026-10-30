'use client'

import { useEffect, useRef } from 'react'
import type { OverlayEventFrame } from '@shared/events'

/**
 * Every `type` the backend can put on an overlay frame, as a runtime array.
 *
 * This is the third spelling of one contract. The other two are the
 * `OverlayEventFrame` union in `shared/events.ts` and the kind constants plus
 * `SERIALISERS` in `api/events.py`. `web/test/test-event-contract.mjs` reads all
 * three out of the source and asserts they agree, because a type is erased at
 * runtime and a constant nobody imports is dead: the literal in the file is the
 * only thing worth pinning.
 *
 * Keep this in step with that union. Adding a kind to the backend without
 * adding it here means the guard below drops it silently, which is the failure
 * this whole arrangement exists to make loud.
 */
const FRAME_KINDS = [
  'comment',
  'gift',
  'like',
  'join',
  'follow',
  'intro',
  'notice',
  'subscription',
  'poll',
  'viewers',
  'share',
  'alert',
  'status',
  'error',
  'config',
] as const satisfies readonly OverlayEventFrame['type'][]

/**
 * Whether a parsed value is a frame this contract describes.
 *
 * A `type` outside the union is dropped rather than handed to the caller. That
 * is behaviour-preserving: every consumer of this hook dispatches on
 * `frame.type` with an explicit `if`/`else if` chain and no `default` branch, so
 * an unrecognised kind was already ignored. The difference is that it is now
 * ignored on purpose, at one place, instead of by luck at each call site.
 */
export function isOverlayFrame(value: unknown): value is OverlayEventFrame {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && (FRAME_KINDS as readonly string[]).includes(type)
}

/**
 * A live room's frames, over the backend's overlay socket.
 *
 * Opens the same `/ws/overlay/<room>` socket the OBS overlays do. That socket is
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
          const frame: unknown = JSON.parse(event.data)
          if (isOverlayFrame(frame)) handlerRef.current(frame)
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
