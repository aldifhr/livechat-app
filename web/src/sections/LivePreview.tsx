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
   * The stage's height, as the overlay itself reports it, and the scale that
   * makes it fit.
   *
   * Two things have to be true at once, and the first version of this got the
   * first one right by breaking the second:
   *
   *   1. Nothing is clipped. A ten-row leaderboard at 28px is ~580px tall, and a
   *      stage locked to `aspect-ratio: 16 / 9` cuts the last row off with no
   *      scrollbar and no error — which reads as a broken overlay rather than as
   *      a frame too short for it.
   *   2. The whole overlay is visible at once, without scrolling. A preview you
   *      have to scroll to see the bottom of is not a preview of what OBS shows;
   *      it is a preview of the top of it, which is exactly the thing the fixed
   *      rectangle was meant to settle.
   *
   * Growing the frame to its natural height satisfies (1) and fails (2) — a
   * 676px stage pushes the fold and the bottom rows are simply below it. So the
   * frame is laid out at its full height and then scaled down to fit the space
   * the page has: every row is present in the box, and the box is small enough
   * to be seen whole. That is what a browser source is too — OBS scales the page
   * into whatever rectangle the operator drew, and this does the same thing.
   *
   * The scale is measured against the VIEWPORT, not against the stage element.
   * A ResizeObserver on the stage cannot give the width the scale needs: the
   * stage's width comes from its parent and its height comes from the iframe it
   * contains, so the measurement the transform is computed from would depend on
   * the transform — the observer would be measuring the thing it is meant to
   * size. The viewport is upstream of all of it and stable.
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

  // Ceiling on the stage, as a share of the window. Enough to read a board
  // comfortably, short enough that the page head and the switch stay on screen
  // with it.
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined' ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight },
  )

  useEffect(() => {
    function onResize() {
      setViewport({ w: window.innerWidth, h: window.innerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const maxStageHeight = Math.max(320, Math.round(viewport.h * 0.62))

  const scale =
    reportedHeight === null
      ? 1
      : // Only ever shrinks: an overlay shorter than the space is shown at its
        // real size, because scaling a 200px chat up to fill a 520px stage would
        // be previewing a font size nobody chose.
        Math.min(1, maxStageHeight / reportedHeight)

  const frameStyle =
    reportedHeight === null
      ? undefined
      : {
          // The full height, then scaled: the frame is laid out whole and the
          // transform only changes how much of the page it occupies.
          height: `${reportedHeight}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }

  // The space the scaled frame actually occupies, so the page below the stage
  // sits under it rather than under its untransformed height.
  const occupied = reportedHeight === null ? undefined : Math.round(reportedHeight * scale)

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
        <div className="preview-stage" style={occupied ? { height: `${occupied}px` } : undefined}>
          {/* The page itself, not a picture of it, so what is watched here is
              exactly what OBS will load. */}
          <iframe src={shown} title="Overlay preview" style={frameStyle} />
        </div>
      )}
    </>
  )
}