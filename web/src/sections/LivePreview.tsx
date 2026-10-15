/**
 * The live preview, full screen.
 *
 * A canvas, like the builder's — fixed, and not resized by whatever the overlay
 * currently has in it. That was tried the other way round first, with the stage
 * growing to fit its contents and scaling itself down, on the reasoning that a
 * ten-row leaderboard gets clipped by a fixed frame. It answers a different
 * question than the one this page is for, and it answers it by moving: a quiet
 * chat sat as a small strip on a 520px floor, swelled as the room warmed up, and
 * the board shrank whenever the ranking did. The page says it is "the real
 * overlay, at the size OBS will show it", and OBS clips too — a board that
 * overflows the canvas is a real problem, and the honest way to find out is to
 * look at the canvas rather than at a frame that has been resized to hide it.
 */

'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/client'
import { useViewportHeight, useViewportWidth } from '@/lib/browser'
import type { Room } from '@/lib/types'
import OverlayStage from '@/components/OverlayStage'

/**
 * The canvas shapes a stream can be. OBS is set per stream, so the preview has to
 * be told rather than assume — a vertical TikTok is not a 16:9 rectangle, and
 * judging a vertical overlay inside a landscape frame says nothing about it.
 */
const CANVASES = [
  { label: '1920×1080', width: 1920, height: 1080 },
  { label: '1280×720', width: 1280, height: 720 },
  { label: '1080×1920', width: 1080, height: 1920 },
  { label: '720×1280', width: 720, height: 1280 },
]

export default function LivePreview() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState('')
  const [which, setWhich] = useState<'chat' | 'board'>('chat')

  // Read once, on mount. A preview that followed the query string as you typed in
  // another tab would reload under you; this is a thing you navigate to and watch.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    setRoomId(q.get('room') || '')
    // Which overlay to open on. Said outright rather than inferred: this used to
    // read `?title=`, which is how the board's link carried a title in its query
    // string — and it no longer carries one, so that test would have silently
    // stopped selecting the board.
    if (q.get('which') === 'board') setWhich('board')
  }, [])

  useEffect(() => {
    api
      .rooms()
      .then(({ rooms: found }) => {
        setRooms(found)
        // With no room named, show the first rather than an empty screen, so the
        // page is worth landing on directly.
        setRoomId((current) => current || (found[0]?.id ?? ''))
      })
      .catch(() => {
        // The room list may be empty before a token is set; an empty picker and an
        // honest message are better than a preview pointed at nothing.
      })
  }, [])

  // A room named by the query string only counts once it has been confirmed to
  // exist, so a stale id shows a real overlay rather than a frame that loads
  // nothing.
  const known = rooms.some((room) => room.id === roomId)
  const selected = known ? roomId : (rooms[0]?.id ?? '')

  // The overlay is pointed at by room alone. Its styling comes from the room's
  // saved config, delivered over the socket the overlay opens on load — so this
  // preview is not a snapshot of a style that was current when the page was
  // opened, it is the same live page OBS is showing. Moving a slider in the builder
  // shows up here without anything being re-pointed.
  const chatUrl = useMemo(() => (selected ? api.chatOverlay(selected) : ''), [selected])
  const boardUrl = useMemo(() => (selected ? api.topChatterOverlay(selected) : ''), [selected])

  const shown = which === 'chat' ? chatUrl : boardUrl

  const [canvas, setCanvas] = useState(CANVASES[0])

  // How much height the canvas may take: the window, less the page head and the
  // controls above it. Enough to read a board at size, short enough that the
  // header stays on screen with it.
  //
  // Both fallbacks are chosen so the server's answer is the one this page had
  // before anything was measured: 770 - 210 is the 560 it used to hardcode, and
  // 1280 is wide enough to take the same branch the desktop layout takes. A
  // server fallback that is some other number makes the first paint and the
  // corrected layout two different designs, which is what this is avoiding.
  const width = useViewportWidth(1280)
  const height = useViewportHeight(770)
  const maxHeight = Math.max(320, height - (width > 720 ? 210 : 300))

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Live preview</h2>
          <p className="muted">
            The real overlay, at the size OBS will show it. Comments appear as the room produces them.
          </p>
        </div>
        <div className="actions">
          {rooms.length > 0 && (
            <select
              value={selected}
              onChange={(event) => setRoomId(event.target.value)}
              aria-label="Room"
            >
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={canvas.label}
            onChange={(e) => setCanvas(CANVASES.find((c) => c.label === e.target.value) ?? CANVASES[0])}
            aria-label="Canvas size"
          >
            {CANVASES.map((c) => (
              <option key={c.label} value={c.label}>
                {c.label}
              </option>
            ))}
          </select>
          <div className="seg">
            <button
              className={which === 'chat' ? 'on' : ''}
              onClick={() => setWhich('chat')}
              disabled={!chatUrl}
            >
              Chat
            </button>
            <button
              className={which === 'board' ? 'on' : ''}
              onClick={() => setWhich('board')}
              disabled={!boardUrl}
            >
              Top chatters
            </button>
          </div>
        </div>
      </div>

      {!shown ? (
        <div className="empty">
          No room to preview. Connect a username on the Rooms tab and its overlay appears here.
        </div>
      ) : (
        <OverlayStage
          variant="canvas"
          url={shown}
          title="Overlay preview"
          canvas={canvas}
          maxHeight={maxHeight}
        />
      )}
    </>
  )
}