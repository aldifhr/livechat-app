import { useEffect, useRef, useState } from 'react'
import { host } from '../lib/sidecar'
import { PLATFORM, PLATFORMS, tiktokUsername } from '../lib/platforms'
import { backendUrl, normaliseUsername, type BackendConfig } from '../lib/backend'
import type { FeedFilters, KindFilter } from '../hooks/useVisibleItems'
import type { Health } from '../hooks/useHealth'
import type { UseSettingsResult } from '../hooks/useSettings'
import type { RoomState } from '../types'

interface Props {
  room: RoomState
  counts: Record<string, number>
  totalReceived: number
  kind: KindFilter
  search: string
  health: Health
  settings: UseSettingsResult
  backend: BackendConfig
  /** The current feed rows, so Clear can say when there is nothing to clear. */
  items: number
  onFiltersChange: (filters: Partial<FeedFilters>) => void
  onClearChat: () => void
  onOpenSettings: () => void
}

/**
 * The toolbar.
 *
 * One room, read from a backend. There is no source picker because there is only
 * one source: the app does not talk to TikTok itself, so a control for choosing
 * between two would be choosing between one thing and nothing.
 *
 * The handle is the one thing asked for, so it sits in front rather than in Set
 * up. The address is not here at all: there is one backend this build knows, and
 * a field for it is a field to get wrong. Set up still has it for the cases where
 * it is genuinely a different address.
 *
 * This row used to carry three switches — collapse spam, gift sound, gift notice
 * — as a glanceable shortcut. They are all behind the gear now, which is the same
 * place the rest of the settings live and the reason this row is only the stream:
 * the handle, the filters, the count, and Clear. Nothing here is a preference
 * anyone reaches for mid-stream.
 */
export function Toolbar({
  room,
  counts,
  totalReceived,
  kind,
  search,
  health,
  settings,
  backend,
  items,
  onFiltersChange,
  onClearChat,
  onOpenSettings,
}: Props) {
  const spec = PLATFORMS[PLATFORM]
  const [busy, setBusy] = useState(false)
  // Seeded once from what was saved, then the user's to edit: re-deriving it on
  // every render would undo half-typed handles under the cursor.
  const [handle, setHandle] = useState(() => normaliseUsername(backend.username))
  const savedHandle = useRef(normaliseUsername(backend.username))

  // The saved handle arrives asynchronously, after this component has already
  // mounted and seeded its state. The initialiser above therefore ran against an
  // empty backend config, and without this the input stayed blank and Connect
  // stayed disabled on every launch — a user with a handle saved had to retype it
  // each time. Adopted once, and only when the field is untouched, so it can never
  // overwrite something half-typed.
  const seeded = useRef(false)
  useEffect(() => {
    const saved = normaliseUsername(backend.username)
    if (seeded.current || saved === '') return
    seeded.current = true
    setHandle((current) => (current.trim() === '' ? saved : current))
    savedHandle.current = saved
  }, [backend.username])

  // Set when a Stop lands, cleared when a new connect starts. It exists only to
  // make the note beside the field stop naming a room that is no longer being
  // read: the field keeps the handle so reconnecting is one click, but "@handle via
  // backend" beside a Disconnected status reads as a connection that never stopped.
  const [disconnected, setDisconnected] = useState(false)

  const isConnecting = busy || room.status === 'connecting'
  // A Stop the host has confirmed, or one this component just made. Both count:
  // the status frame can lag the click, and a button that still reads "Stop" after
  // Stop has been pressed is the bug — connect, stop, and the button should say
  // Connect again, not invite another Stop on a room that is already closed.
  const isConnected = room.status === 'connected' && !disconnected
  const wanted = normaliseUsername(handle)
  const canConnect = wanted !== '' && !isConnecting

  /*
    Remembered as soon as it stops changing, not on connect: being made to
    reconnect to save a handle is the same as not remembering it. Debounced
    because a save per keystroke is a write per keystroke, and `savedHandle`
    stops the timer mattering once it has landed.

    The URL is saved exactly as it stands rather than through `backendUrl`,
    which substitutes the built-in default for a blank field. Doing that here
    meant typing a handle for the first time silently wrote a backend address
    the user had never chosen into their config; the host already applies the
    same default when it reads the field back.
  */
  useEffect(() => {
    if (!wanted || wanted === savedHandle.current) return
    const timer = setTimeout(() => {
      savedHandle.current = wanted
      // The raw field, not the resolved address. Writing `backendUrl(backend)` here
      // would substitute the built-in default into a config the user never chose,
      // and from then on the app could not tell "they never set one" from "they set
      // this one" — a different address would look like a change they made. The host
      // applies the same default when it reads the field back, so an empty value
      // connects identically and stays honest about where it came from.
      host.backendConfigSave({ baseUrl: backend.baseUrl, username: wanted }).catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [wanted, backend])

  async function connect() {
    setBusy(true)
    setDisconnected(false)
    onClearChat()
    try {
      // No overlay styling rides along with the connect any more. It used to, so
      // the backend could store the look on the room and the overlay link could be
      // a bare `?room=<id>`; the styling is configured from the web admin panel now
      // and stored there, so the app has nothing to add. The field is left off the
      // wire entirely rather than sent empty, and the host reads that as "no
      // styling", which leaves whatever the admin set alone.
      await host.backendConnect({ baseUrl: backendUrl(backend), username: wanted })
      savedHandle.current = wanted
    } catch {
      // The host's rejection says why in words — no room for that handle, the URL
      // is wrong, the host is down. The status line picks it up; this only has to
      // not leave the button stuck on "Connecting…" for ever.
      setBusy(false)
      return
    }
    setBusy(false)
  }

  async function disconnect() {
    setBusy(true)
    try {
      await host.backendDisconnect()
      // The handle stays in the field — it is what makes reconnecting one click —
      // but the note beside it stops naming a room the app is no longer reading.
      // Leaving it there reads as a connection that is still live, which is the
      // one thing a Stop button must never appear to have failed to do.
      setDisconnected(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="toolbar">
      <div className="room-row">
        <input
          className="input handle-input"
          placeholder="Streamer's handle"
          aria-label="Streamer's TikTok handle"
          value={handle}
          disabled={isConnected}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canConnect) connect()
          }}
        />
        {isConnected ? (
          <button className="btn btn-danger" onClick={disconnect}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={connect} disabled={!canConnect}>
            {isConnecting ? 'Connecting…' : 'Connect'}
          </button>
        )}
        {isConnected && room.target && (
          <button
            className="btn btn-small watch-btn"
            title={`Open tiktok.com/@${tiktokUsername(room.target)}/live in your browser`}
            onClick={() =>
              host
                .openStream(`https://www.tiktok.com/@${encodeURIComponent(tiktokUsername(room.target))}/live`)
                .catch(() => {})
            }
          >
            Watch
          </button>
        )}
        {/* The note names what is being read, and only that. With no handle typed
            there is nothing to name, and the feed already says "Enter a username
            above and press Connect" — a second "Type the handle to start" beside a
            "Not connected" status is the same instruction twice on one screen. So
            the note is silent until there is a handle to say something about. */}
        {wanted ? (
          <span className="source-note">
            {disconnected ? (
              // Stopped. The handle is still in the field, so it is still named here
              // — but as a handle, not as a room being read, and the backend is not
              // mentioned at all because the app is not talking to it.
              <>
                <strong>@{wanted}</strong> — stopped
              </>
            ) : (
              <>
                <strong>@{wanted}</strong> via {backendUrl(backend).replace(/^https?:\/\//, '')}
              </>
            )}
          </span>
        ) : null}

        <div className={`status status-${room.status} room-status`}>
          <span className="dot" />
          <span>
            {health === 'stalled'
              ? 'No messages for a while — the stream may have ended'
              : room.message ||
                (room.status === 'connected'
                  ? 'Live'
                  : // The one place the idle screen is told what to do. The feed
                    // repeats it; nothing else in the toolbar does.
                    'Not connected — enter a handle and press Connect')}
          </span>
          {room.viewers > 0 && (
            <span className="viewers">{room.viewers.toLocaleString()} watching</span>
          )}
        </div>
        {room.title && <p className="room-title">{room.title}</p>}
      </div>

      {/* Filters and search appear only once there is a feed to filter. Before
          that they are controls for nothing — an idle screen carrying a row of
          chips and an empty search box reads as clutter, and the search field
          suggests there is content to look through when there is not. */}
      {(room.status === 'connected' || items > 0) && (
        <div className="toolbar-bottom">
          <div className="filters">
            {spec.kinds.map((option) => (
              <button
                key={option.value}
                className={`chip chip-small${kind === option.value ? ' chip-active' : ''}`}
                onClick={() => onFiltersChange({ kind: option.value })}
              >
                {option.label}
                {option.value !== 'all' && counts[option.value] > 0 && (
                  <span className="chip-count">{counts[option.value]}</span>
                )}
              </button>
            ))}
          </div>

          <input
            className="input input-search"
            placeholder="Filter by name or text"
            value={search}
            onChange={(e) => onFiltersChange({ search: e.target.value })}
          />
        </div>
      )}

      {/*
        The stream itself: the handle, connect, filters, and what is left worth
        reading mid-stream. Everything else — theme, font, density, the panels, the
        model, and every standing preference like the collapse switch and the gift
        sounds — is behind the gear.

        Two ends, one row: what happened on the left, what you can do on the right.
        The count is the thing you watch and the buttons are the thing you reach
        for, so they are not neighbours. It reads as one row rather than two only
        because there is a single auto margin doing the pushing; two of them split
        the free space instead of dividing the row.
      */}
      <div className="view-toggles">
        <span className="summary">
          {totalReceived.toLocaleString()} events
          {kind !== 'all' && ` · ${spec.kinds.find((k) => k.value === kind)?.label.toLowerCase()}`}
          {search.trim() && ' · search'}
        </span>

        <span className="view-actions">
          <button
            className="btn btn-small"
            onClick={onClearChat}
            disabled={items === 0}
            title="Clear every row from the feed"
          >
            Clear
          </button>

          <button
            className="btn btn-small settings-btn"
            onClick={onOpenSettings}
            title="Theme, font, density, panels and model"
            aria-label="Settings"
          >
            ⚙
          </button>
          <span className="font-hint" title="Ctrl + scroll anywhere in the window">
            {Math.round(settings.fontScale * 100)}%
          </span>
        </span>
      </div>
    </div>
  )
}