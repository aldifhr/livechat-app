/**
 * The live preview.
 *
 * A page of its own rather than half of the builder, for two reasons. A browser
 * source in OBS is a fixed rectangle, and to see whether the overlay actually fits
 * it you want the overlay at that size on the whole screen — with controls beside
 * it, the preview is always smaller than the thing it is supposed to be a preview
 * of. And a preview is what you leave on a second monitor while you talk to chat;
 * that is a window you navigate to, not a panel inside a form.
 *
 * The room and which overlay to show arrive in the query string. The style does
 * not, and does not need to: the overlay fetches it from the room over the socket
 * it opens on load, so this page is showing the live thing rather than a
 * reconstruction of it.
 */

'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, type Room } from '@/lib/client'
import OverlayStage from '@/components/OverlayStage'

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

  // Ceiling on the frame, as a share of the window. Enough to read a board
  // comfortably, short enough that the page head and the switch stay on screen
  // with it.
  const maxStageHeight =
    typeof window === 'undefined' ? 520 : Math.max(320, Math.round(window.innerHeight * 0.62))

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
        <OverlayStage url={shown} title="Overlay preview" maxHeight={maxStageHeight} />
      )}
    </>
  )
}