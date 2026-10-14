/**
 * Two customizers, one per overlay.
 *
 * Deliberately not one panel with a switch, and not one style object shared
 * between both: the chat overlay and the top-chatters board read different
 * parameters. The board ignores the message gap entirely and carries a title the
 * chat overlay has no place for; the chat overlay has no board to name. One shared
 * style meant a delay slider that did nothing on the board and a link for the chat
 * overlay that quietly carried the board's row count.
 *
 * Each side reads and writes its own query string through shared/, so the bounds
 * the customizer enforces are the same ones the page enforces. What is copied into
 * OBS is exactly what the controls describe.
 */

'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chatStyleFromQuery,
  chatStyleToQuery,
  chatStyleToStored,
  boardStyleFromQuery,
  boardStyleToStored,
  boardStyleToQuery,
  resolveBoardStyle,
  resolveStyle,
  styleFromStored,
  BOARD_DEFAULT_STYLE,
  OVERLAY_DELAY,
  OVERLAY_DEFAULT_STYLE,
  OVERLAY_MAX_ROWS,
  OVERLAY_SIZE,
  OVERLAY_TITLE_MAX,
  type BoardStyle,
  type OverlayStyle,
} from '@shared/overlay'
import { api, type Room } from '../lib/client'
import { usePersistedStyle, type SaveState } from './usePersistedStyle'

/** The room picker both customizers share — the room is what an overlay points at. */
function RoomPicker({
  rooms,
  selected,
  onChange,
}: {
  rooms: Room[]
  selected: string
  onChange: (id: string) => void
}) {
  return (
    <div className="field">
      <label htmlFor="room">Room</label>
      <select id="room" value={selected} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose a room…</option>
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.name}
          </option>
        ))}
      </select>
    </div>
  )
}

/** A read-only link with a copy button — the thing that ends up in OBS. */
function CopyLink({ label, hint, url }: { label: string; hint: string; url: string }) {
  const [copied, setCopied] = useState(false)
  // The timer is cleared on unmount. Without it, copying and then navigating away
  // inside the 1.5s window leaves a callback that sets state on a component that
  // is gone — harmless in React 18, but a leak the next reader has to re-derive.
  const resetTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => {
        resetTimer.current = null
        setCopied(false)
      }, 1500)
    } catch {
      // Clipboard access is refused in some contexts and there is no honest way to
      // paste on the operator's behalf; the field is selectable, so they can.
    }
  }
  return (
    <div className="panel">
      <h3>{label}</h3>
      <div className="copy-row">
        <textarea readOnly value={url} onFocus={(e) => e.target.select()} aria-label={label} rows={2} />
        <button onClick={() => void copy()} disabled={!url}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint && <p className="faint">{hint}</p>}
    </div>
  )
}

// ---- the chat customizer --------------------------------------------------

function ChatCustomizer({ roomId, style, onChange }: {
  roomId: string
  style: OverlayStyle
  onChange: (change: Partial<OverlayStyle>) => void
}) {
  const chatUrl = useMemo(
    () => (roomId ? api.chatOverlay(roomId, chatStyleToQuery(style)) : ''),
    [roomId, style],
  )
  const preview = `/admin/live-preview?${new URLSearchParams({ room: roomId, ...chatStyleToQuery(style) }).toString()}`

  return (
    <>
      <div className="panel">
        <h3>Style</h3>

        <div className="field">
          <label>Text size <span className="value">{style.size}px</span></label>
          <input type="range" min={OVERLAY_SIZE.min} max={OVERLAY_SIZE.max} value={style.size} onChange={(e) => onChange({ size: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label>Messages on screen <span className="value">{style.max}</span></label>
          <input type="range" min={OVERLAY_MAX_ROWS.min} max={OVERLAY_MAX_ROWS.max} value={style.max} onChange={(e) => onChange({ max: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label>Gap between messages <span className="value">{style.delay}ms</span></label>
          <input type="range" min={OVERLAY_DELAY.min} max={OVERLAY_DELAY.max} step={20} value={style.delay} onChange={(e) => onChange({ delay: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label>Background <span className="value">{Math.round(style.bg * 100)}%</span></label>
          <input type="range" min={0} max={1} step={0.05} value={style.bg} onChange={(e) => onChange({ bg: Number(e.target.value) })} />
        </div>

        <div className="field-row">
          <div className="field">
            <label>Name colour</label>
            <input type="color" value={style.nameColour} onChange={(e) => onChange({ nameColour: e.target.value })} />
          </div>
          <div className="field">
            <label>Text colour</label>
            <input type="color" value={style.textColour} onChange={(e) => onChange({ textColour: e.target.value })} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="chat-font">Font</label>
          <input id="chat-font" value={style.font} onChange={(e) => onChange({ font: e.target.value })} />
        </div>

        <button onClick={() => onChange(OVERLAY_DEFAULT_STYLE)}>Reset to defaults</button>
      </div>

      <div>
        <CopyLink
          label="Chat overlay link"
          hint="Add this as a browser source in OBS, sized to your canvas."
          url={chatUrl}
        />
        <Link className="btn stack-top" href={preview}>
          Open live preview
        </Link>
      </div>
    </>
  )
}

// ---- the board customizer -------------------------------------------------

function BoardCustomizer({ roomId, style, onChange }: {
  roomId: string
  style: BoardStyle
  onChange: (change: Partial<BoardStyle>) => void
}) {
  const boardUrl = useMemo(
    () => (roomId ? api.topChatterOverlay(roomId, boardStyleToQuery(style)) : ''),
    [roomId, style],
  )
  const preview = `/admin/live-preview?${new URLSearchParams({ room: roomId, ...boardStyleToQuery(style) }).toString()}`

  return (
    <>
      <div className="panel">
        <h3>Style</h3>

        <div className="field">
          <label htmlFor="board-title">Title</label>
          <input
            id="board-title"
            value={style.title}
            maxLength={OVERLAY_TITLE_MAX}
            placeholder="Top Yapping"
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </div>

        <div className="field">
          <label>Text size <span className="value">{style.size}px</span></label>
          <input type="range" min={OVERLAY_SIZE.min} max={OVERLAY_SIZE.max} value={style.size} onChange={(e) => onChange({ size: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label>Chatters listed <span className="value">{style.max}</span></label>
          <input type="range" min={OVERLAY_MAX_ROWS.min} max={OVERLAY_MAX_ROWS.max} value={style.max} onChange={(e) => onChange({ max: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label>Panel background <span className="value">{Math.round(style.bg * 100)}%</span></label>
          <input type="range" min={0} max={1} step={0.05} value={style.bg} onChange={(e) => onChange({ bg: Number(e.target.value) })} />
        </div>

        <div className="field-row">
          <div className="field">
            <label>Accent colour</label>
            <input type="color" value={style.nameColour} onChange={(e) => onChange({ nameColour: e.target.value })} />
          </div>
          <div className="field">
            <label>Text colour</label>
            <input type="color" value={style.textColour} onChange={(e) => onChange({ textColour: e.target.value })} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="board-font">Font</label>
          <input id="board-font" value={style.font} onChange={(e) => onChange({ font: e.target.value })} />
        </div>

        <button onClick={() => onChange(BOARD_DEFAULT_STYLE)}>Reset to defaults</button>
      </div>

      <div>
        <CopyLink label="Top chatters link" hint="" url={boardUrl} />
        <Link className="btn stack-top" href={preview}>
          Open live preview
        </Link>
      </div>
    </>
  )
}

// ---- the page -------------------------------------------------------------

type Which = 'chat' | 'board'

/** What the operator is told about the save. Never a guess, never a silence. */
function SaveBadge({ state }: { state: SaveState }) {
  const text =
    state === 'pending'
      ? 'Menyimpan…'
      : state === 'saved'
        ? 'Tersimpan'
        : state === 'failed'
          ? 'Gagal menyimpan'
          : ''
  return (
    <span className={state === 'failed' ? 'save-state failed' : 'save-state'} role="status">
      {text}
    </span>
  )
}

export default function OverlayBuilder({ initialRoom }: { initialRoom?: string }) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState(initialRoom ?? '')
  const [which, setWhich] = useState<Which>('chat')

  // The query string, read after mount rather than in a state initialiser: those run
  // during the server render too, where `window` does not exist, and the page
  // answered 500 with `ReferenceError: window is not defined` on every request.
  const search = useRef('')
  useEffect(() => {
    search.current = window.location.search
    if (!initialRoom) {
      const fromQuery = new URLSearchParams(search.current).get('room')
      if (fromQuery) setRoomId(fromQuery)
    }
  }, [initialRoom])

  useEffect(() => {
    api
      .rooms()
      .then(({ rooms: found }) => {
        setRooms(found)
        setRoomId((current) => current || (found[0]?.id ?? ''))
      })
      .catch(() => {
        // The builder is reachable before a token is set and the room list may
        // still be empty at that point; an empty select is a fair answer here and
        // the rest of the section stays usable.
      })
  }, [])

  // A room named by the query string only counts once it has been confirmed to
  // exist, so a stale id produces a fallback rather than a link pointing at a
  // room nobody is watching.
  const known = rooms.some((room) => room.id === roomId)
  const selected = known ? roomId : (rooms[0]?.id ?? '')
  const room = rooms.find((r) => r.id === selected)

  /**
   * Read a room's saved styling, falling back to whatever the link carried.
   *
   * The fallback is for a room that has never been styled, which is exactly where a
   * link pasted before styles were saved carries its own settings. Once a room has
   * something stored, that is what the editor opens on — a link's parameters are a
   * snapshot from whenever it was copied, and letting one win would make every saved
   * change invisible.
   */
  const readChat = useCallback(
    (config: Record<string, unknown>) => {
      const stored = styleFromStored(config)
      return Object.keys(stored).length > 0
        ? resolveStyle(stored)
        : chatStyleFromQuery(search.current)
    },
    [],
  )

  const readBoard = useCallback(
    (config: Record<string, unknown>) => {
      const stored = styleFromStored(config)
      return Object.keys(stored).length > 0
        ? resolveBoardStyle(stored)
        : boardStyleFromQuery(search.current)
    },
    [],
  )

  const chat = usePersistedStyle({
    room,
    fallback: OVERLAY_DEFAULT_STYLE,
    read: readChat,
    write: chatStyleToStored,
  })

  const board = usePersistedStyle({
    room,
    fallback: BOARD_DEFAULT_STYLE,
    read: readBoard,
    write: boardStyleToStored,
  })

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Overlay builder</h2>
          <p className="muted">
            Style each overlay, then paste its link into OBS as a browser source.
          </p>
        </div>
      </div>

      <div className="panel">
        <RoomPicker rooms={rooms} selected={selected} onChange={setRoomId} />
        <div className="seg stack-top">
          <button className={which === 'chat' ? 'on' : ''} onClick={() => setWhich('chat')}>
            Chat overlay
          </button>
          <button className={which === 'board' ? 'on' : ''} onClick={() => setWhich('board')}>
            Top chatters
          </button>
        </div>
      </div>

      <div className="builder">
        {which === 'chat' ? (
          <>
            <ChatCustomizer roomId={selected} style={chat.current} onChange={chat.patch} />
            <SaveBadge state={chat.state} />
          </>
        ) : (
          <>
            <BoardCustomizer roomId={selected} style={board.current} onChange={board.patch} />
            <SaveBadge state={board.state} />
          </>
        )}
      </div>
    </>
  )
}