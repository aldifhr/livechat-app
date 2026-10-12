/**
 * The overlay builder: styling on the left, the live overlay on the right.
 *
 * The controls write into the overlay's own query string rather than saving a
 * style anywhere, so the URL below them is not a summary of the settings — it is
 * the settings. What is copied into OBS is exactly what is being previewed, which
 * is the only way to be sure the two have not drifted.
 *
 * The numbers come from shared/, so the bounds enforced here are the same ones the
 * page enforces. A field that let you save a value the page would clamp would
 * show one number in this dashboard and a different one in OBS.
 */

'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  clampRows,
  isSafeColour,
  OVERLAY_DEFAULT_STYLE,
  OVERLAY_DELAY,
  OVERLAY_MAX_ROWS,
  OVERLAY_SIZE,
  resolveOverlayFont,
  type OverlayStyle,
} from '@shared/overlay'
import { api, type Room } from '../lib/client'

/** Pull a style back out of a saved URL, so opening the builder on a link that
 *  was shared with somebody shows their overlay rather than the defaults. */
function styleFromQuery(search: string): OverlayStyle {
  const q = new URLSearchParams(search)
  const num = (key: string) => (q.has(key) ? Number(q.get(key)) : undefined)
  const raw = {
    size: num('size'),
    max: num('max'),
    delay: num('delay'),
    bg: num('bg'),
    nameColour: q.get('name'),
    textColour: q.get('color'),
    font: q.get('font'),
  }
  return {
    size: clamp(Number.isFinite(raw.size) ? (raw.size as number) : OVERLAY_DEFAULT_STYLE.size, OVERLAY_SIZE.min, OVERLAY_SIZE.max, OVERLAY_DEFAULT_STYLE.size),
    max: clampRows(raw.max, OVERLAY_DEFAULT_STYLE.max),
    delay: Math.round(clamp(Number.isFinite(raw.delay) ? (raw.delay as number) : OVERLAY_DEFAULT_STYLE.delay, OVERLAY_DELAY.min, OVERLAY_DELAY.max, OVERLAY_DEFAULT_STYLE.delay)),
    bg: clamp(Number.isFinite(raw.bg) ? (raw.bg as number) : OVERLAY_DEFAULT_STYLE.bg, 0, 1, OVERLAY_DEFAULT_STYLE.bg),
    nameColour: safeColour(raw.nameColour, OVERLAY_DEFAULT_STYLE.nameColour),
    textColour: safeColour(raw.textColour, OVERLAY_DEFAULT_STYLE.textColour),
    font: resolveOverlayFont(raw.font),
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function safeColour(value: string | null, fallback: string): string {
  return value !== null && isSafeColour(value) ? value.trim() : fallback
}

export default function OverlayBuilder({ initialRoom }: { initialRoom?: string }) {
  const [rooms, setRooms] = useState<Room[]>([])
  // A room named by the Rooms tab wins over the URL, because a tab switch is a
  // more recent instruction than a link somebody pasted earlier.
  const [roomId, setRoomId] = useState(
    () => initialRoom || new URLSearchParams(window.location.search).get('room') || '',
  )
  const [style, setStyle] = useState<OverlayStyle>(() => styleFromQuery(window.location.search))
  const [copied, setCopied] = useState('')

  useEffect(() => {
    api
      .rooms()
      .then(({ rooms: found }) => {
        setRooms(found)
        // With no room chosen, pick the first rather than leaving the field blank
        // and the preview pointed at nothing.
        setRoomId((current) => current || (found[0]?.id ?? ''))
      })
      .catch(() => {
        // The builder is reachable before a token is set and the room list may
        // still be empty at that point; an empty select is a fair answer here and
        // the rest of the section stays usable.
      })
  }, [])

  const patch = useCallback((change: Partial<OverlayStyle>) => setStyle((current) => ({ ...current, ...change })), [])

  // A room named by the query string only counts once it has been confirmed to
  // exist. A stale or wrong id in the address would otherwise produce a
  // complete-looking overlay link that points at a room nobody is watching —
  // the worst kind of wrong, because it looks exactly like a working one.
  const known = rooms.some((room) => room.id === roomId)
  const selected = known ? roomId : rooms[0]?.id ?? ''

  const chatUrl = useMemo(() => (selected ? api.chatOverlay(selected, styleToQuery(style)) : ''), [selected, style])
  const boardUrl = useMemo(
    () => (selected ? api.topChatterOverlay(selected, { max: String(style.max) }) : ''),
    [selected, style.max],
  )

  const copy = async (label: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(label)
      window.setTimeout(() => setCopied(''), 1500)
    } catch {
      // Clipboard access is refused in some contexts and there is no honest way to
      // paste on the operator's behalf; the field is selectable, so they can.
      setCopied('')
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Overlay builder</h2>
          <p className="muted" style={{ margin: 0 }}>
            Style the overlay, then paste the link into OBS as a browser source.
          </p>
          {/* The preview moved to its own page: a browser source is a fixed
              rectangle, and seeing whether the overlay fits it needs the whole
              screen. The style travels in the query string, so this opens on
              exactly what the link below produces. */}
          <Link
            className="btn"
            href={`/admin/live-preview?room=${encodeURIComponent(selected)}&${new URLSearchParams(styleToQuery(style)).toString()}`}
          >
            Open live preview
          </Link>
        </div>
      </div>

      <div className="panel">
        <div className="field">
          <label htmlFor="room">Room</label>
          <select id="room" value={selected} onChange={(event) => setRoomId(event.target.value)}>
            <option value="">Choose a room…</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="builder">
        <div className="panel" style={{ margin: 0 }}>
          <h3>Style</h3>

          <div className="field">
            <label>
              Text size <span className="value">{style.size}px</span>
            </label>
            <input type="range" min={OVERLAY_SIZE.min} max={OVERLAY_SIZE.max} value={style.size} onChange={(e) => patch({ size: Number(e.target.value) })} />
          </div>

          <div className="field">
            <label>
              Messages on screen <span className="value">{style.max}</span>
            </label>
            <input type="range" min={OVERLAY_MAX_ROWS.min} max={OVERLAY_MAX_ROWS.max} value={style.max} onChange={(e) => patch({ max: Number(e.target.value) })} />
          </div>

          <div className="field">
            <label>
              Gap between messages <span className="value">{style.delay}ms</span>
            </label>
            <input type="range" min={OVERLAY_DELAY.min} max={OVERLAY_DELAY.max} step={20} value={style.delay} onChange={(e) => patch({ delay: Number(e.target.value) })} />
          </div>

          <div className="field">
            <label>
              Background <span className="value">{Math.round(style.bg * 100)}%</span>
            </label>
            <input type="range" min={0} max={1} step={0.05} value={style.bg} onChange={(e) => patch({ bg: Number(e.target.value) })} />
          </div>

          <div className="field-row">
            <div className="field">
              <label>Name colour</label>
              <input type="color" value={style.nameColour} onChange={(e) => patch({ nameColour: e.target.value })} />
            </div>
            <div className="field">
              <label>Text colour</label>
              <input type="color" value={style.textColour} onChange={(e) => patch({ textColour: e.target.value })} />
            </div>
          </div>

          <div className="field">
            <label htmlFor="font">Font</label>
            <input id="font" value={style.font} onChange={(e) => patch({ font: e.target.value })} />
          </div>

          <button onClick={() => setStyle(OVERLAY_DEFAULT_STYLE)}>Reset to defaults</button>
        </div>

        <div>
          <div className="panel" style={{ marginBottom: '1rem' }}>
            <h3>Chat overlay link</h3>
            <div className="copy-row">
              <input readOnly value={chatUrl} onFocus={(e) => e.target.select()} aria-label="Chat overlay link" />
              <button onClick={() => void copy('chat', chatUrl)} disabled={!chatUrl}>
                {copied === 'chat' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="faint" style={{ margin: 0 }}>
              Add this as a browser source in OBS, sized to your canvas.
            </p>
          </div>

          <div className="panel" style={{ marginBottom: '1rem' }}>
            <h3>Top chatters link</h3>
            <div className="copy-row">
              <input readOnly value={boardUrl} onFocus={(e) => e.target.select()} aria-label="Top chatters link" />
              <button onClick={() => void copy('board', boardUrl)} disabled={!boardUrl}>
                {copied === 'board' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

        </div>
      </div>
    </>
  )
}

/** The overlay's styling, as the query parameters it reads. */
function styleToQuery(style: OverlayStyle): Record<string, string> {
  return {
    size: String(style.size),
    max: String(style.max),
    delay: String(style.delay),
    bg: String(style.bg),
    name: style.nameColour,
    color: style.textColour,
    font: style.font,
  }
}