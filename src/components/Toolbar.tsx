import { useEffect, useRef, useState } from 'react'
import { host } from '../lib/sidecar'
import { PLATFORM, PLATFORMS } from '../lib/platforms'
import { backendUrl, normaliseUsername, type BackendConfig } from '../lib/backend'
import type { FeedFilters, KindFilter } from '../hooks/useVisibleItems'
import type { Health } from '../hooks/useHealth'
import type { UseSettingsResult, ViewSettings } from '../hooks/useSettings'
import type { RoomState } from '../types'

interface Props {
  room: RoomState
  counts: Record<string, number>
  totalReceived: number
  kind: KindFilter
  search: string
  collapse: boolean
  health: Health
  settings: UseSettingsResult
  backend: BackendConfig
  /** The current feed rows, so Clear can say when there is nothing to clear. */
  items: number
  onFiltersChange: (filters: Partial<FeedFilters>) => void
  onCollapseChange: (enabled: boolean) => void
  onClearChat: () => void
  onOpenSettings: () => void
  /**
   * Reports whatever is in the handle field, as it changes.
   *
   * The field's state stays here, where it belongs with the logic around it, and
   * this is the one thing outside that needs to know what it says: the overlay
   * link. Lifting the state instead would put the debounced save and the
   * seed-once-from-saved logic in the app for one consumer's benefit.
   *
   * `wanted`, not the raw field, so the app gets the same normalised handle
   * Connect would use rather than something that has to be normalised again.
   */
  onHandleChange?: (handle: string) => void
}

const TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'giftSound', label: 'Gift sound', hint: 'Chime when a gift arrives' },
  { key: 'giftNotice', label: 'Gift notice', hint: 'Raise a desktop toast when a gift arrives' },
]

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
 */
export function Toolbar({
  room,
  counts,
  totalReceived,
  kind,
  search,
  collapse,
  health,
  settings,
  backend,
  items,
  onFiltersChange,
  onCollapseChange,
  onClearChat,
  onOpenSettings,
  onHandleChange,
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

  // Reported as it changes rather than read back on demand: the overlay link is
  // built in the settings dialog, which has no way to ask this component what is
  // in the field, and a handle copied before Connect is pressed is exactly the
  // one a streamer wants on their overlay.
  useEffect(() => {
    onHandleChange?.(wanted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted])

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
            title={`Open tiktok.com/@${room.target}/live in your browser`}
            onClick={() =>
              host
                .openStream(`https://www.tiktok.com/@${encodeURIComponent(room.target)}/live`)
                .catch(() => {})
            }
          >
            Watch
          </button>
        )}
        <span className="source-note">
          {!wanted ? (
            'Type the handle to start'
          ) : disconnected ? (
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

        <div className={`status status-${room.status} room-status`}>
          <span className="dot" />
          <span>
            {health === 'stalled'
              ? 'No messages for a while — the stream may have ended'
              : room.message || 'Not connected'}
          </span>
          {room.viewers > 0 && (
            <span className="viewers">{room.viewers.toLocaleString()} watching</span>
          )}
        </div>
        {room.title && <p className="room-title">{room.title}</p>}
      </div>

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

      {/*
        The stream itself: the handle, connect, filters, and the few things worth
        a glance while watching. Everything else — theme, font, density, the
        panels, the model — is behind the gear. This row used to carry a look
        switcher of its own and a Model button, which pushed the chat below the
        fold and made the toolbar something to scroll past.
      */}
      <div className="view-toggles">
        <label className="toggle" title="Collapse identical consecutive messages">
          <input type="checkbox" checked={collapse} onChange={(e) => onCollapseChange(e.target.checked)} />
          <span>Collapse spam</span>
        </label>
        {TOGGLES.map((option) => (
          <label key={option.key} className="toggle" title={option.hint}>
            <input
              type="checkbox"
              checked={Boolean(settings[option.key])}
              onChange={(e) => settings.set(option.key, e.target.checked as never)}
            />
            <span>{option.label}</span>
          </label>
        ))}

        <span className="summary">
          {totalReceived.toLocaleString()} events
          {kind !== 'all' && ` · ${spec.kinds.find((k) => k.value === kind)?.label.toLowerCase()}`}
          {search.trim() && ' · search'}
        </span>

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
      </div>
    </div>
  )
}