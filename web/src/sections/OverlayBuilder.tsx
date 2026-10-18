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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chatStyleFromQuery,
  chatStyleToStored,
  boardStyleFromQuery,
  boardStyleToStored,
  resolveBoardStyle,
  resolveStyle,
  styleFromStored,
  BOARD_DEFAULT_STYLE,
  OVERLAY_DELAY,
  OVERLAY_DEFAULT_STYLE,
  OVERLAY_MAX_ROWS,
  OVERLAY_MAX_WIDTH,
  OVERLAY_SIZE,
  OVERLAY_TITLE_MAX,
  type BoardStyle,
  type OverlayStyle,
  type OverlayPosition,
} from '@shared/overlay'
import { api } from '../lib/client/api'
import type { Room, RoomStatus } from '../lib/types'
import { labelOf, orderForPicker, pickDefaultRoom, type RoomChoice } from '../lib/roomLive'
import CopyField from '../components/CopyField'
import OverlayStage from '../components/OverlayStage'
import { usePersistedStyle, type SaveState } from '@/hooks/usePersistedStyle'

/** The room picker both customizers share — the room is what an overlay points at. */
function RoomPicker({
  choices,
  selected,
  onChange,
}: {
  choices: RoomChoice[]
  selected: string
  onChange: (id: string) => void
}) {
  // Live first, then waiting, then offline — see `orderForPicker`. Each entry says
  // which it is, because a name alone gave no way to tell a room that can produce
  // chat from one that cannot, and the picker defaulted to whichever happened to
  // be created first.
  const liveCount = choices.filter((choice) => choice.live === 'live').length
  return (
    <div className="field">
      <label htmlFor="room">Room</label>
      <select id="room" value={selected} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose a room…</option>
        {choices.map(({ room, live }) => (
          <option key={room.id} value={room.id}>
            {room.name} — {labelOf(live)}
          </option>
        ))}
      </select>
      <p className="hint">
        {liveCount === 0
          ? 'No room is live right now. An offline room still has styling to edit — the overlay appears when the stream starts.'
          : `${liveCount} room${liveCount === 1 ? '' : 's'} live now, listed first.`}
      </p>
    </div>
  )
}

// ---- the chat customizer --------------------------------------------------

function ChatCustomizer({ roomId, style, design, saveState, onChange }: {
  roomId: string
  style: OverlayStyle
  design: 'original' | 'studio'
  saveState: SaveState
  onChange: (change: Partial<OverlayStyle>) => void
}) {
  const chatUrl = useMemo(() => (roomId ? api.chatOverlay(roomId, design) : ''), [roomId, design])

  return (
    <>
      <div className="panel">
        <h3>Style</h3>

        <p className="style-group-title">Content</p>

        <div className="field">
          <label>Text size <span className="value">{style.size}px</span></label>
          <input type="range" min={OVERLAY_SIZE.min} max={OVERLAY_SIZE.max} value={style.size} onChange={(e) => onChange({ size: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label>Messages on screen <span className="value">{style.max}</span></label>
          <input type="range" min={OVERLAY_MAX_ROWS.min} max={OVERLAY_MAX_ROWS.max} value={style.max} onChange={(e) => onChange({ max: Number(e.target.value) })} />
        </div>

        <p className="style-group-title">Position and width</p>

        <div className="field">
          <label htmlFor="chat-position">Chat position</label>
          <select
            id="chat-position"
            value={style.position}
            onChange={(e) => onChange({ position: e.target.value as OverlayPosition })}
          >
            <option value="top-left">Top left</option>
            <option value="top-right">Top right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="bottom-right">Bottom right</option>
          </select>
          <div className="flex items-center justify-between gap-3 mt-2">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => onChange({ position: OVERLAY_DEFAULT_STYLE.position })}
              disabled={style.position === OVERLAY_DEFAULT_STYLE.position}
            >
              Reset position
            </button>
            <SaveBadge state={saveState} />
          </div>
        </div>

        <div className="field">
          <label>Maximum chat width <span className="value">{style.maxWidth}em</span></label>
          <input
            type="range"
            min={OVERLAY_MAX_WIDTH.min}
            max={OVERLAY_MAX_WIDTH.max}
            value={style.maxWidth}
            onChange={(e) => onChange({ maxWidth: Number(e.target.value) })}
          />
        </div>

        <div className="field">
          <label htmlFor="chat-speed">Message speed</label>
          <select
            id="chat-speed"
            value={style.delay === 200 ? 'fast' : style.delay === 900 ? 'relaxed' : style.delay === 500 ? 'normal' : 'custom'}
            onChange={(e) => {
              const delays = { fast: 200, normal: 500, relaxed: 900 }
              const delay = delays[e.target.value as keyof typeof delays]
              if (delay) onChange({ delay })
            }}
          >
            <option value="fast">Fast</option>
            <option value="normal">Normal</option>
            <option value="relaxed">Relaxed</option>
            <option value="custom" disabled>Custom ({style.delay}ms)</option>
          </select>
        </div>

        <div className="field">
          <label>Custom message interval <span className="value">{style.delay}ms</span></label>
          <input type="range" min={OVERLAY_DELAY.min} max={OVERLAY_DELAY.max} step={20} value={style.delay} onChange={(e) => onChange({ delay: Number(e.target.value) })} />
        </div>

        <p className="style-group-title">Background and color</p>

        <div className="field">
          <label>Row background opacity <span className="value">{Math.round(style.bg * 100)}%</span></label>
          <input type="range" min={0} max={1} step={0.05} value={style.bg} onChange={(e) => onChange({ bg: Number(e.target.value) })} />
        </div>

        {design === 'studio' && (
          <div className="field">
            <label>Studio bubble opacity <span className="value">{Math.round(style.bubbleOpacity * 100)}%</span></label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.bubbleOpacity}
              onChange={(e) => onChange({ bubbleOpacity: Number(e.target.value) })}
            />
          </div>
        )}

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
          <label>Gift colour</label>
          <input type="color" value={style.giftColour} onChange={(e) => onChange({ giftColour: e.target.value })} />
        </div>

        <div className="field">
          <label htmlFor="chat-font">Font</label>
          <input id="chat-font" value={style.font} onChange={(e) => onChange({ font: e.target.value })} />
        </div>

        <button onClick={() => onChange(OVERLAY_DEFAULT_STYLE)}>Reset to defaults</button>
      </div>

      <div>
        <CopyField
          label={`Chat overlay · ${design === 'studio' ? 'Studio' : 'Original'}`}
          url={chatUrl}
          hint="Add as a browser source in OBS, sized to your canvas."
        />
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
  const boardUrl = useMemo(() => (roomId ? api.topChatterOverlay(roomId) : ''), [roomId])

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
        <CopyField label="Top chatters" url={boardUrl} hint="Add as a browser source in OBS, sized to your canvas." />
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
      ? 'Saving…'
      : state === 'saved'
        ? 'Saved'
        : state === 'failed'
          ? 'Save failed'
          : ''
  return (
    <span className={state === 'failed' ? 'save-state failed' : 'save-state'} role="status">
      {text}
    </span>
  )
}

/** The canvas shapes a stream can be. OBS is set per stream, so the preview has
 *  to be told rather than assume — a vertical TikTok is not a 16:9 rectangle, and
 *  judging a vertical overlay inside a landscape frame says nothing about it. */
const CANVASES = [
  { label: '1920×1080', width: 1920, height: 1080 },
  { label: '1280×720', width: 1280, height: 720 },
  { label: '1080×1920', width: 1080, height: 1920 },
  { label: '720×1280', width: 720, height: 1280 },
]

export default function OverlayBuilder({ initialRoom }: { initialRoom?: string }) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [statuses, setStatuses] = useState<Record<string, RoomStatus | undefined>>({})
  const [roomId, setRoomId] = useState(initialRoom ?? '')
  const [which, setWhich] = useState<Which>('chat')
  const [chatDesign, setChatDesign] = useState<'original' | 'studio'>('original')
  const [canvas, setCanvas] = useState(CANVASES[0])

  // The query string, read after mount rather than in a state initialiser: those run
  // during the server render too, where `window` does not exist, and the page
  // answered 500 with `ReferenceError: window is not defined` on every request.
  const search = useRef('')
  useEffect(() => {
    search.current = window.location.search
    if (new URLSearchParams(search.current).get('design') === 'studio') setChatDesign('studio')
    if (!initialRoom) {
      const fromQuery = new URLSearchParams(search.current).get('room')
      if (fromQuery) setRoomId(fromQuery)
    }
  }, [initialRoom])

  useEffect(() => {
    let cancelled = false
    api
      .rooms()
      .then(async ({ rooms: found }) => {
        setRooms(found)
        // Read every room's state so the picker can order by it and say which is
        // which. A status that cannot be read is left undefined and reads as
        // offline, which is the honest answer for a room nothing can be said
        // about — the alternative is a badge that guesses.
        const read: Record<string, RoomStatus | undefined> = {}
        await Promise.all(
          found.map(async (room) => {
            try {
              read[room.id] = await api.status(room.id)
            } catch {
              read[room.id] = undefined
            }
          }),
        )
        if (cancelled) return
        setStatuses(read)
        // Live first, and the default is the first live room rather than whichever
        // was created first — the bug this exists for: every visit opened on an
        // offline room while a live one sat further down the list.
        const choices = orderForPicker(found, read)
        setRoomId((current) => current || pickDefaultRoom(choices))
      })
      .catch(() => {
        // The builder is reachable before a token is set and the room list may
        // still be empty at that point; an empty select is a fair answer here and
        // the rest of the section stays usable.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Ordered once here rather than in the render: the picker reads this, and a
  // fresh sort per render would reshuffle it as statuses poll.
  const choices = useMemo(() => orderForPicker(rooms, statuses), [rooms, statuses])

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
        <RoomPicker choices={choices} selected={selected} onChange={setRoomId} />
        <div className="seg stack-top">
          <button className={which === 'chat' ? 'on' : ''} onClick={() => setWhich('chat')}>
            Chat overlay
          </button>
          <button className={which === 'board' ? 'on' : ''} onClick={() => setWhich('board')}>
            Top chatters
          </button>
        </div>
        {which === 'chat' && (
          <div className="seg stack-top" aria-label="Chat overlay design">
            <button className={chatDesign === 'original' ? 'on' : ''} onClick={() => setChatDesign('original')}>
              Original
            </button>
            <button className={chatDesign === 'studio' ? 'on' : ''} onClick={() => setChatDesign('studio')}>
              Studio
            </button>
          </div>
        )}
      </div>

      {/*
        Controls on the left, the overlay itself on the right.

        This used to mean leaving the page: the preview had its own address, so
        seeing whether a size fitted meant copying the current settings into a
        query string, opening another tab, and coming back. Now that the overlay
        fetches its styling live, the frame beside the controls is the same live
        page OBS is showing — moving a slider changes it directly, with nothing to
        re-point and nothing to come back from.

        The full-screen preview still exists at its own address. It is worth keeping
        for the case this frame is bad at: judging an overlay against a real canvas
        size, full screen, on a second monitor.
      */}
      <div className="builder">
        <div className="builder-controls">
          {which === 'chat' ? (
            <ChatCustomizer
              roomId={selected}
              style={chat.current}
              design={chatDesign}
              saveState={chat.state}
              onChange={chat.patch}
            />
          ) : (
            <BoardCustomizer roomId={selected} style={board.current} onChange={board.patch} />
          )}
          {which === 'board' && <SaveBadge state={board.state} />}
        </div>

        <div className="builder-stage">
          {selected ? (
            <>
              <div className="builder-stage-head">
                <span className="copy-label">Preview</span>
                <div className="builder-stage-actions">
                  <select
                    value={canvas.label}
                    onChange={(e) =>
                      setCanvas(CANVASES.find((c) => c.label === e.target.value) ?? CANVASES[0])
                    }
                    aria-label="Preview canvas size"
                  >
                    {CANVASES.map((c) => (
                      <option key={c.label} value={c.label}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {/* A fixed canvas, not a frame that fits its contents. The overlay
                  inside grows downward from the top exactly as it does on a
                  stream, so a quiet chat is a short column of messages rather than
                  a small box that swells as the room warms up. */}
              <OverlayStage
                variant="canvas"
                url={which === 'chat' ? api.chatOverlay(selected, chatDesign) : api.topChatterOverlay(selected)}
                title={`${which === 'chat' ? 'Chat' : 'Top chatters'} overlay preview`}
                canvas={canvas}
                previewStyle={which === 'chat' ? chat.current : undefined}
              />
              <p className="faint tight-caption">
                The overlay on a {canvas.width}×{canvas.height} canvas — what OBS shows. It changes as
                you move the controls.
              </p>
            </>
          ) : (
            <div className="empty">No stream selected, so there is nothing to preview.</div>
          )}
        </div>
      </div>
    </>
  )
}
