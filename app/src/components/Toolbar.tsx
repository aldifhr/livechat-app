import { useEffect, useRef, useState } from 'react'
import { RollingNumber } from './RollingNumber'
import { endSession, host } from '../lib/sidecar'
import { PLATFORM, PLATFORMS, tiktokUsername } from '../lib/platforms'
import { backendUrl, normaliseUsername, type BackendConfig } from '../lib/backend'
import type { FeedFilters, KindFilter } from '../hooks/useVisibleItems'
import type { Health } from '../hooks/useHealth'
import type { UseSettingsResult } from '../hooks/useSettings'
import type { RoomState } from '../types'

interface Props {
  room: RoomState
  liveSince: number | null
  counts: Record<string, number>
  totalReceived: number
  kind: KindFilter
  search: string
  health: Health
  settings: UseSettingsResult
  backend: BackendConfig
  onBackendChange: (backend: BackendConfig) => void
  /** The current feed rows, so Clear can say when there is nothing to clear. */
  items: number
  onFiltersChange: (filters: Partial<FeedFilters>) => void
  onClearChat: () => void
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
 * This row carries the stream controls: the handle, filters, event count, and
 * Clear. Navigation to the other pages lives in the Dock.
 */
export function Toolbar({
  room,
  liveSince,
  counts,
  totalReceived,
  kind,
  search,
  health,
  settings,
  backend,
  onBackendChange,
  items,
  onFiltersChange,
  onClearChat,
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
  const connectedMessage = room.message.match(/^(Connected to\s+)(@.+)$/i)

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
      const nextBackend = { ...backend, username: wanted }
      host.backendConfigSave({ baseUrl: backend.baseUrl, username: wanted })
        .then(() => onBackendChange(nextBackend))
        .catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [wanted, backend, onBackendChange])

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
    // Closed before the host is asked, so the feed stops at the click rather than
    // at the confirmation. A frame already in flight when Stop is pressed arrives
    // after the press, and without this it would land under a badge that already
    // says the reading stopped. The host is genuinely stopped too — this closes
    // the door on frames that were already on their way through it.
    endSession()
    try {
      await host.backendDisconnect()
      // The handle stays in the field — it is what makes reconnecting one click —
      // but the note beside it stops naming a room the app is no longer reading.
      // Leaving it there reads as a connection that is still live, which is the
      // one thing a Stop button must never appear to have failed to do.
      setDisconnected(true)
      onClearChat()
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
            title={`Open tiktok.com/@${room.target}/live in your browser`}
            onClick={() =>
              host
                .openStream(`https://www.tiktok.com/@${encodeURIComponent(tiktokUsername(room.target))}/live`)
                .catch(() => {})
            }
          >
            Watch
          </button>
        )}
        <div className={`status status-${room.status} room-status`}>
          <span className="dot" />
          <span>
            {health === 'stalled'
              ? 'No messages for a while — the stream may have ended'
              : connectedMessage
                ? <>{connectedMessage[1]}<strong>{connectedMessage[2]}</strong></>
              : room.message ||
                (room.status === 'connected'
                  ? 'Live'
                  : // The one place the idle screen is told what to do. The feed
                    // repeats it; nothing else in the toolbar does.
                    'Not connected — enter a handle and press Connect')}
          </span>
          {isConnected && room.viewers > 0 && (
            <span className="viewers"><RollingNumber value={room.viewers} /> watching</span>
          )}
        {isConnected && liveSince !== null && <LiveTimer startedAt={liveSince} />}
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
        reading mid-stream. The Dock owns navigation to the other pages.

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

          <span className="font-hint" title="Ctrl + scroll anywhere in the window">
            {Math.round(settings.fontScale * 100)}%
          </span>
        </span>
      </div>
    </div>
  )
}

function LiveTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60
  const time = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')

  return <span className="live-timer" title="Durasi terhubung ke live">LIVE {time}</span>
}
