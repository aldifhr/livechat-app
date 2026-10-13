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

  /*
   * The stage's height, as the overlay itself reports it.
   *
   * `aspect-ratio: 16 / 9` is the right default — it is the shape of an OBS
   * canvas and it fills the screen — but it is a floor, not a ceiling. A
   * ten-row leaderboard at 28px is ~580px tall, which is taller than the 520px a
   * 926px-wide 16:9 stage has, and a stage whose height is locked to its aspect
   * ratio then clips the last row with no scrollbar and no error: a board that
   * is visibly cut off reads as a broken overlay rather than as a frame that is
   * too short for it.
   *
   * The overlay knows how tall it actually is; nothing outside it can compute
   * that, because it depends on the row count, the font size, the padding and
   * every operator-chosen value. So it reports the number and the stage takes
   * the larger of the two. `null` until the first report, which leaves the
   * aspect ratio in charge rather than collapsing the stage to nothing.
   *
   * The reported height goes on the IFRAME, not on min-height of the stage: the
   * stage's `aspect-ratio` still resolves its own height from its width, and a
   * min-height on the stage grows the black box without growing the iframe
   * inside it — which leaves the board clipped in a taller frame, the same bug
   * with more empty space around it. Sizing the iframe lets the stage wrap it.
   */
  const [reportedHeight, setReportedHeight] = useState<number | null>(null)

  useEffect(() => {
    // A new overlay is a new height; the old one belongs to the page being left.
    setReportedHeight(null)
    function onMessage(event: MessageEvent) {
      // Any origin: this is a preview of a page this dashboard itself served, and
      // the only thing taken from the message is a number that is clamped before
      // it is used as a height.
      const height = (event.data as { streamkitHeight?: unknown } | null)?.streamkitHeight
      if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
        setReportedHeight(Math.min(Math.ceil(height), 4000))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [shown])

  const frameStyle =
    reportedHeight === null
      ? undefined
      : // Clamped between the stage's own floor and a ceiling: a quiet room
        // reports a short chat and the preview would collapse to a sliver, while
        // a long chat would grow past the fold. The stage's `min-height` holds
        // the bottom; this holds the top.
        { height: `${Math.max(520, Math.min(Math.ceil(reportedHeight), 1600))}px` }

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
        <div className="preview-stage">
          {/* The page itself, not a picture of it, so what is watched here is
              exactly what OBS will load. */}
          <iframe src={shown} title="Overlay preview" style={frameStyle} />
        </div>
      )}
    </>
  )
}