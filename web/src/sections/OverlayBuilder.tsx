/**
 * One customizer per overlay: the chat, the top-chatters board, the cat and the
 * likes target.
 *
 * Deliberately not one panel with a switch, and not one style object shared
 * between them: each overlay reads different parameters. The board ignores the
 * message gap entirely and carries a title the chat overlay has no place for; the
 * cat has neither a chat nor a board to name. One shared style meant a delay slider
 * that did nothing on the board and a link for the chat overlay that quietly
 * carried the board's row count.
 *
 * Each side reads and writes its own fields through shared/, so the bounds the
 * customizer enforces are the same ones the page enforces. What is copied into OBS
 * is exactly what the controls describe.
 */

'use client'

import Link from 'next/link'
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
  catStyleToStored,
  resolveCatStyle,
  CAT_DEFAULT_STYLE,
  likeTargetStyleToStored,
  resolveLikeTargetStyle,
  LIKE_TARGET_DEFAULT_STYLE,
  LIKE_TARGET_MIN,
  LIKE_TARGET_MAX,
  LIKE_TITLE_MAX,
  type BoardStyle,
  type CatPalette,
  type CatStyle,
  type LikeTargetStyle,
  type OverlayStyle,
  type OverlayPosition,
} from '@shared/overlay'
import { api } from '../lib/client/api'
import { profilePath } from '../lib/client/streamLinks'
import type { Room } from '../lib/types'
import CopyField from '../components/CopyField'
import OverlayStage from '../components/OverlayStage'
import { usePersistedStyle, type SaveState } from '@/hooks/usePersistedStyle'

// ---- the chat customizer --------------------------------------------------

function ChatCustomizer({ roomId, style, design, onChange }: {
  roomId: string
  style: OverlayStyle
  design: 'original' | 'studio'
  onChange: (change: Partial<OverlayStyle>) => void
}) {
  const chatUrl = useMemo(() => (roomId ? api.chatOverlay(roomId, design) : ''), [roomId, design])

  return (
    <>
      <div className="panel">
        <h3>Style</h3>

        <p className="style-group-title">Content</p>

        <div className="field">
          <label htmlFor="chat-size">Text size <span className="value">{style.size}px</span></label>
          <input id="chat-size" type="range" min={OVERLAY_SIZE.min} max={OVERLAY_SIZE.max} value={style.size} onChange={(e) => onChange({ size: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label htmlFor="chat-max">Messages on screen <span className="value">{style.max}</span></label>
          <input id="chat-max" type="range" min={OVERLAY_MAX_ROWS.min} max={OVERLAY_MAX_ROWS.max} value={style.max} onChange={(e) => onChange({ max: Number(e.target.value) })} />
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
          <div className="mt-2">
            <button
              type="button"
              className="btn-small"
              onClick={() => onChange({ position: OVERLAY_DEFAULT_STYLE.position })}
              disabled={style.position === OVERLAY_DEFAULT_STYLE.position}
            >
              Reset position
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="chat-max-width">Maximum chat width <span className="value">{style.maxWidth}em</span></label>
          <input
            id="chat-max-width"
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
          <label htmlFor="chat-delay">Custom message interval <span className="value">{style.delay}ms</span></label>
          <input id="chat-delay" type="range" min={OVERLAY_DELAY.min} max={OVERLAY_DELAY.max} step={20} value={style.delay} onChange={(e) => onChange({ delay: Number(e.target.value) })} />
        </div>

        <p className="style-group-title">Background and color</p>

        <div className="field">
          <label htmlFor="chat-bg">Row background opacity <span className="value">{Math.round(style.bg * 100)}%</span></label>
          <input id="chat-bg" type="range" min={0} max={1} step={0.05} value={style.bg} onChange={(e) => onChange({ bg: Number(e.target.value) })} />
        </div>

        {design === 'studio' && (
          <div className="field">
            <label htmlFor="chat-bubble-opacity">Studio bubble opacity <span className="value">{Math.round(style.bubbleOpacity * 100)}%</span></label>
            <input
              id="chat-bubble-opacity"
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
            <label htmlFor="chat-name-colour">Name colour</label>
            <input id="chat-name-colour" type="color" value={style.nameColour} onChange={(e) => onChange({ nameColour: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="chat-text-colour">Text colour</label>
            <input id="chat-text-colour" type="color" value={style.textColour} onChange={(e) => onChange({ textColour: e.target.value })} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="chat-gift-colour">Gift colour</label>
          <input id="chat-gift-colour" type="color" value={style.giftColour} onChange={(e) => onChange({ giftColour: e.target.value })} />
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
          <label htmlFor="board-size">Text size <span className="value">{style.size}px</span></label>
          <input id="board-size" type="range" min={OVERLAY_SIZE.min} max={OVERLAY_SIZE.max} value={style.size} onChange={(e) => onChange({ size: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label htmlFor="board-max">Chatters listed <span className="value">{style.max}</span></label>
          <input id="board-max" type="range" min={OVERLAY_MAX_ROWS.min} max={OVERLAY_MAX_ROWS.max} value={style.max} onChange={(e) => onChange({ max: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label htmlFor="board-bg">Panel background <span className="value">{Math.round(style.bg * 100)}%</span></label>
          <input id="board-bg" type="range" min={0} max={1} step={0.05} value={style.bg} onChange={(e) => onChange({ bg: Number(e.target.value) })} />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="board-name-colour">Accent colour</label>
            <input id="board-name-colour" type="color" value={style.nameColour} onChange={(e) => onChange({ nameColour: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="board-text-colour">Text colour</label>
            <input id="board-text-colour" type="color" value={style.textColour} onChange={(e) => onChange({ textColour: e.target.value })} />
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

// ---- the cat customizer ---------------------------------------------------

function CatCustomizer({ roomId, style, onChange }: {
  roomId: string
  style: CatStyle
  onChange: (change: Partial<CatStyle>) => void
}) {
  const catUrl = useMemo(() => (roomId ? api.catOverlay(roomId) : ''), [roomId])

  return (
    <>
      <div className="panel">
        <h3>Style</h3>

        <p className="style-group-title">Appearance</p>

        <div className="field">
          <label htmlFor="cat-palette">Fur colour</label>
          <select
            id="cat-palette"
            value={style.pal}
            onChange={(e) => onChange({ pal: e.target.value as CatPalette })}
          >
            <option value="oren">Orange</option>
            <option value="abu">Grey</option>
            <option value="hitam">Black</option>
            <option value="putih">White</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="cat-chonk">Chonk</label>
          <select
            id="cat-chonk"
            value={style.chonk ? 'on' : 'off'}
            onChange={(e) => onChange({ chonk: e.target.value === 'on' })}
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </div>

        <button onClick={() => onChange(CAT_DEFAULT_STYLE)}>Reset to defaults</button>
      </div>

      <div>
        <CopyField label="Cat overlay" url={catUrl} hint="Add as a browser source in OBS, sized to your canvas." />
      </div>
    </>
  )
}

// ---- the likes target customizer ------------------------------------------

function LikeTargetCustomizer({ roomId, style, onChange }: {
  roomId: string
  style: LikeTargetStyle
  onChange: (change: Partial<LikeTargetStyle>) => void
}) {
  const likesUrl = useMemo(() => (roomId ? api.likeTargetOverlay(roomId) : ''), [roomId])

  return (
    <>
      <div className="panel">
        <h3>Style</h3>

        <p className="style-group-title">Goal</p>

        <div className="field">
          <label htmlFor="likes-target">Target likes</label>
          <input
            id="likes-target"
            type="number"
            min={LIKE_TARGET_MIN}
            max={LIKE_TARGET_MAX}
            value={style.likeTarget}
            onChange={(e) =>
              onChange({
                likeTarget: Math.max(LIKE_TARGET_MIN, Math.min(LIKE_TARGET_MAX, Math.round(Number(e.target.value) || LIKE_TARGET_MIN))),
              })
            }
          />
        </div>

        <div className="field">
          <label htmlFor="likes-title">Title</label>
          <input
            id="likes-title"
            maxLength={LIKE_TITLE_MAX}
            value={style.likeTitle}
            placeholder="Target Likes"
            onChange={(e) => onChange({ likeTitle: e.target.value })}
          />
        </div>

        <p className="style-group-title">Appearance</p>

        <div className="field">
          <label htmlFor="likes-size">Text size <span className="value">{style.likeSize}px</span></label>
          <input id="likes-size" type="range" min={OVERLAY_SIZE.min} max={OVERLAY_SIZE.max} value={style.likeSize} onChange={(e) => onChange({ likeSize: Number(e.target.value) })} />
        </div>

        <div className="field">
          <label htmlFor="likes-position">Position</label>
          <select id="likes-position" value={style.likePosition} onChange={(e) => onChange({ likePosition: e.target.value as OverlayPosition })}>
            <option value="top-left">Top left</option>
            <option value="top-right">Top right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="bottom-right">Bottom right</option>
          </select>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="likes-bar-colour">Bar colour</label>
            <input id="likes-bar-colour" type="color" value={style.likeBarColour} onChange={(e) => onChange({ likeBarColour: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="likes-text-colour">Text colour</label>
            <input id="likes-text-colour" type="color" value={style.likeTextColour} onChange={(e) => onChange({ likeTextColour: e.target.value })} />
          </div>
        </div>

        <button onClick={() => onChange(LIKE_TARGET_DEFAULT_STYLE)}>Reset to defaults</button>
      </div>

      <div>
        <CopyField label="Likes target" url={likesUrl} hint="Add as a browser source in OBS, sized to your canvas." />
      </div>
    </>
  )
}

// ---- the page -------------------------------------------------------------

/** Which overlay this page styles. One route per kind. */
export type BuilderKind = 'chat' | 'board' | 'cat' | 'likes'

/** What the operator is told about the save. Never a guess, never a silence. */
function SaveBadge({ state }: { state: SaveState }) {
  const text =
    state === 'dirty'
      ? 'Unsaved changes'
      : state === 'saving'
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

export default function OverlayBuilder({
  handle,
  kind,
}: {
  handle: string
  kind: BuilderKind
}) {
  // The handle is the part a person types; a room with no handle is reachable by its
  // id, the same two forms the profile resolves. The leading `@` is optional.
  const wanted = decodeURIComponent(handle).trim().replace(/^@/, '')
  const [rooms, setRooms] = useState<Room[]>([])
  const [loadedRooms, setLoadedRooms] = useState(false)
  const [chatDesign, setChatDesign] = useState<'original' | 'studio'>('original')
  const [canvas, setCanvas] = useState(CANVASES[0])

  // The query string, read after mount rather than in a state initialiser: those run
  // during the server render too, where `window` does not exist, and the page
  // answered 500 with `ReferenceError: window is not defined` on every request.
  const search = useRef('')
  useEffect(() => {
    search.current = window.location.search
    if (new URLSearchParams(search.current).get('design') === 'studio') setChatDesign('studio')
  }, [])

  // The room list is the only way to reach a room's saved styling. The list is behind
  // the session, so a handle that names nothing is discovered here, after the read,
  // rather than at request time — and a room that was just renamed still resolves.
  useEffect(() => {
    let cancelled = false
    api
      .rooms()
      .then(({ rooms: found }) => {
        if (!cancelled) setRooms(found)
      })
      .catch(() => {
        // A list that cannot be read is an empty list here; the page then says the
        // stream was not found rather than pretending to style one it cannot see.
      })
      .finally(() => {
        if (!cancelled) setLoadedRooms(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const room = rooms.find((candidate) => candidate.username === wanted || candidate.id === wanted)
  const selected = room?.id ?? ''

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

  const readCat = useCallback(
    (config: Record<string, unknown>) => resolveCatStyle(styleFromStored(config)),
    [],
  )

  const readLikeTarget = useCallback(
    (config: Record<string, unknown>) => resolveLikeTargetStyle(styleFromStored(config)),
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

  const cat = usePersistedStyle({
    room,
    fallback: CAT_DEFAULT_STYLE,
    read: readCat,
    write: catStyleToStored,
  })

  const likes = usePersistedStyle({
    room,
    fallback: LIKE_TARGET_DEFAULT_STYLE,
    read: readLikeTarget,
    write: likeTargetStyleToStored,
  })

  // The customizer on screen, so the one Save button and its status belong to
  // the overlay this route styles.
  const active = kind === 'chat' ? chat : kind === 'board' ? board : kind === 'cat' ? cat : likes
  const heading =
    kind === 'chat' ? 'Chat overlay' : kind === 'board' ? 'Top chatters' : kind === 'cat' ? 'Cat overlay' : 'Likes target'

  if (!loadedRooms) {
    return <div className="empty">Loading this stream…</div>
  }

  if (!room) {
    return (
      <>
        <div className="page-head">
          <div>
            <h2>No such stream</h2>
            <p className="muted">
              Nothing here is called <strong>@{wanted}</strong>. It may have been deleted, or the
              address may have a typo in it.
            </p>
          </div>
        </div>
        <div className="panel">
          <Link className="btn" href="/streams">
            Back to streams
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="faint">
            <Link className="quiet-link" href={profilePath(room.username, room.id)}>
              ← {room.username ? `@${room.username}` : room.name}
            </Link>
          </p>
          <h2>{heading}</h2>
          <p className="muted">
            Style this overlay, then paste its link into OBS as a browser source.
          </p>
        </div>
      </div>

      {kind === 'chat' && (
        <div className="seg mb-4" aria-label="Chat overlay design">
          <button aria-pressed={chatDesign === 'original'} className={chatDesign === 'original' ? 'on' : ''} onClick={() => setChatDesign('original')}>
            Original
          </button>
          <button aria-pressed={chatDesign === 'studio'} className={chatDesign === 'studio' ? 'on' : ''} onClick={() => setChatDesign('studio')}>
            Studio
          </button>
        </div>
      )}

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
          {kind === 'chat' ? (
            <ChatCustomizer
              roomId={selected}
              style={chat.current}
              design={chatDesign}
              onChange={chat.patch}
            />
          ) : kind === 'board' ? (
            <BoardCustomizer roomId={selected} style={board.current} onChange={board.patch} />
          ) : kind === 'cat' ? (
            <CatCustomizer roomId={selected} style={cat.current} onChange={cat.patch} />
          ) : (
            <LikeTargetCustomizer roomId={selected} style={likes.current} onChange={likes.patch} />
          )}
          <div className="flex items-center justify-between gap-3 mt-1">
            <SaveBadge state={active.state} />
            <button
              className="primary"
              onClick={active.save}
              disabled={!active.dirty || !active.enabled}
            >
              Save
            </button>
          </div>
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
                url={
                  kind === 'chat'
                    ? api.chatOverlay(selected, chatDesign)
                    : kind === 'board'
                      ? api.topChatterOverlay(selected)
                      : kind === 'cat'
                        ? api.catOverlay(selected)
                        : api.likeTargetOverlay(selected)
                }
                title={`${kind === 'chat' ? 'Chat' : kind === 'board' ? 'Top chatters' : kind === 'cat' ? 'Cat' : 'Likes target'} overlay preview`}
                canvas={canvas}
                previewStyle={
                  kind === 'chat' ? chat.current : kind === 'board' ? board.current : kind === 'cat' ? cat.current : likes.current
                }
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
