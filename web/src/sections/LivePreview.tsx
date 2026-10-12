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
 * The room, the style and which overlay to show arrive in the query string, so this
 * page reads exactly what the customizer wrote and shows exactly what OBS will
 * load. There is no second copy of the settings that could drift from the link
 * being previewed.
 *
 * The bounds come from shared/ rather than being restated here, so a value this
 * page accepts is one the overlay page will actually render.
 */

'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  chatStyleFromQuery,
  chatStyleToQuery,
  boardStyleFromQuery,
  boardStyleToQuery,
} from '@shared/overlay'
import { api, type Room } from '@/lib/client'

export default function LivePreview() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState('')
  const [which, setWhich] = useState<'chat' | 'board'>('chat')

  // Read once, on mount. A preview that followed the query string as you typed in
  // another tab would reload under you; this is a thing you navigate to and watch.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    setRoomId(q.get('room') || '')
    // A link from the board customizer carries a title; that is how the preview
    // knows which overlay to show, without a separate flag on the wire.
    if (q.has('title')) setWhich('board')
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
  const selected = known ? roomId : rooms[0]?.id ?? ''
  const search = typeof window === 'undefined' ? '' : window.location.search

  const chatStyle = useMemo(() => chatStyleFromQuery(search), [search])
  const boardStyle = useMemo(() => boardStyleFromQuery(search), [search])

  const chatUrl = useMemo(
    () => (selected ? api.chatOverlay(selected, chatStyleToQuery(chatStyle)) : ''),
    [selected, chatStyle],
  )
  const boardUrl = useMemo(
    () => (selected ? api.topChatterOverlay(selected, boardStyleToQuery(boardStyle)) : ''),
    [selected, boardStyle],
  )

  const shown = which === 'chat' ? chatUrl : boardUrl

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Live preview</h2>
          <p className="muted" style={{ margin: 0 }}>
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
        <div className="preview-stage">
          <div className="preview-frame">
            {/* The page itself, not a picture of it, so what is watched here is
                exactly what OBS will load. */}
            <iframe src={shown} title="Overlay preview" />
          </div>
        </div>
      )}
    </>
  )
}