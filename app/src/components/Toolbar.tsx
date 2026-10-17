import { useEffect, useRef, useState } from 'react'
import { RollingNumber } from './RollingNumber'
import { endSession, host } from '../lib/sidecar'
import { PLATFORM, PLATFORMS, tiktokUsername } from '../lib/platforms'
import { backendUrl, normaliseUsername, type BackendConfig } from '../lib/backend'
import type { FeedFilters, KindFilter } from '../hooks/useVisibleItems'
import type { Health } from '../hooks/useHealth'
import type { UseSettingsResult } from '../hooks/useSettings'
import type { RoomState } from '../types'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Label } from './ui/label'

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

  // The same gap, for a page that loaded while a stream was already being read.
  //
  // A reload replaces this component while the host keeps reading, so the config
  // may hold nothing (or a different handle) even though a room is connected —
  // and the field would sit empty beside a Stop button, with the note naming a
  // room whose handle is nowhere on screen. `room.target` is what the reader is
  // actually on, so it fills the field whenever the field is still untouched.
  // Never over a half-typed handle, for the same reason as the effect above.
  useEffect(() => {
    const reading = normaliseUsername(room.target)
    if (reading === '') return
    setHandle((current) => (current.trim() === '' ? reading : current))
  }, [room.target])

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
  // The backend is polling for a streamer with no live right now. A source *is*
  // running — it is what will pick the stream up when it starts — so this needs
  // Stop, not a disabled "Connecting…". That wait can last two hours, and a state
  // the user cannot leave is a trap rather than a state.
  const isWaiting = room.status === 'waiting' && !disconnected
  const wanted = normaliseUsername(handle)
  const watchTarget = tiktokUsername(room.target || wanted)
  // Not while waiting: a source is running and the button beside it is Stop, so
  // offering Connect as well would invite a second connection to a room that
  // already has one.
  const canConnect = wanted !== '' && !isConnecting && !isWaiting
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
    <div className="toolbar [flex:0_0_auto] [display:flex] [flex-direction:column] [gap:10px] [padding:14px_20px] [background:var(--panel)] [border-bottom:1px_solid_var(--line)] [max-height:min(40vh,_440px)] [overflow-y:auto] [scrollbar-width:thin]">
      <div className="room-row [display:flex] [align-items:center] [gap:8px] [flex-wrap:wrap] [&_.input]:[flex:1_1_260px] [&_.handle-input]:[flex:0_1_240px]">
        <Label htmlFor="stream-handle" className="sr-only">Streamer's TikTok handle</Label>
        <Input
          id="stream-handle"
          className="input handle-input [flex:1] [min-width:0] [padding:9px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [outline:none] [&:focus]:[border-color:var(--accent)] [&::placeholder]:[color:var(--muted)]"
          placeholder="Streamer's handle"
          value={handle}
          disabled={isConnected || isWaiting}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canConnect) connect()
          }}
        />
        {isConnected || isWaiting ? (
          <Button variant="outline" className="btn btn-danger [padding:9px_14px] [background:transparent] [border-color:var(--accent)] [color:var(--accent)] [font:inherit] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)]" onClick={disconnect}>
            Stop
          </Button>
        ) : (
          <Button className="btn btn-primary [padding:9px_14px] [background:var(--accent)] [border-color:var(--accent)] [color:var(--bg)] [font:inherit] [font-weight:600] [white-space:nowrap]" onClick={connect} disabled={!canConnect}>
            {isConnecting ? 'Connecting…' : 'Connect'}
          </Button>
        )}
        {isConnected && watchTarget && (
          <Button
            variant="secondary"
            className="btn btn-small watch-btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed] [align-self:center] [padding:4px_10px] [font-size:12px]"
            title={`Open tiktok.com/@${watchTarget}/live in your browser`}
            onClick={() =>
              host
                .openStream(`https://www.tiktok.com/@${encodeURIComponent(watchTarget)}/live`)
                .catch(() => {})
            }
          >
            Watch
          </Button>
        )}
        <div className={`status status-${room.status} room-status [display:flex] [align-items:center] [gap:8px] [font-size:13px] [color:var(--muted)] [&_.dot]:[width:8px] [&_.dot]:[height:8px] [&_.dot]:[border-radius:50%] [&_.dot]:[background:var(--muted)] [&_.dot]:[flex:0_0_auto] [&.status-connected]:[color:var(--text)] [&.status-connected_.dot]:[background:var(--green)] [&.status-connecting_.dot]:[background:var(--gold)] [&.status-waiting_.dot]:[background:var(--gold)] [&.status-error]:[color:var(--accent)] [&.status-error_.dot]:[background:var(--accent)] [&.status-ended]:[color:var(--muted)]`}>
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
            <span className="viewers [padding:2px_8px] [background:color-mix(in_srgb,_var(--green)_14%,_transparent)] [border-radius:999px] [color:var(--green)] [font-weight:600] [font-variant-numeric:tabular-nums] [white-space:nowrap]"><RollingNumber value={room.viewers} /> watching</span>
          )}
        {isConnected && liveSince !== null && <LiveTimer startedAt={liveSince} />}
        </div>
        {room.title && <p className="room-title [flex:1_1_100%] [margin:0] [width:100%] [color:var(--muted)] [font-size:13px] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">{room.title}</p>}
      </div>

      {/* Filters and search appear only once there is a feed to filter. Before
          that they are controls for nothing — an idle screen carrying a row of
          chips and an empty search box reads as clutter, and the search field
          suggests there is content to look through when there is not. */}
      {(room.status === 'connected' || items > 0) && (
        <div className="toolbar-bottom [display:flex] [align-items:center] [gap:12px] [flex-wrap:wrap]">
          <ToggleGroup
            type="single"
            spacing={1}
            value={kind}
            onValueChange={(value) => { if (value) onFiltersChange({ kind: value as KindFilter }) }}
            aria-label="Filter feed by event type"
            className="filters [display:flex] [gap:8px] [flex-wrap:wrap] [&_.chip]:[gap:4px] [&_.chip-count]:[padding:0_4px] [&_.chip-count]:[font-size:10px]"
          >
            {spec.kinds.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="chip chip-small [display:inline-flex] [align-items:center] [gap:4px] [padding:3px_8px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:999px] [color:var(--muted)] [font:inherit] [font-size:11px] [&:hover]:[color:var(--text)] data-[state=on]:[background:var(--accent-soft)] data-[state=on]:[border-color:var(--accent)] data-[state=on]:[color:var(--text)]"
              >
                {option.label}
                {option.value !== 'all' && counts[option.value] > 0 && (
                  <Badge variant="secondary" className="chip-count border-0 bg-white/10 px-1 py-0 text-[10px] font-normal tabular-nums text-app-muted">{counts[option.value]}</Badge>
                )}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Label htmlFor="feed-search" className="sr-only">Filter by name or text</Label>
          <Input
            id="feed-search"
            className="input input-search [flex:1] [min-width:0] [padding:9px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [outline:none] [&:focus]:[border-color:var(--accent)] [&::placeholder]:[color:var(--muted)] [flex:0_1_240px]"
            placeholder="Filter by name or text"
            value={search}
            aria-label="Filter by name or text"
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
      <div className="view-toggles [display:flex] [align-items:center] [gap:14px] [flex-wrap:wrap]">
        <span className="summary [color:var(--muted)] [font-size:11px] [font-variant-numeric:tabular-nums]">
          {totalReceived.toLocaleString()} events
          {kind !== 'all' && ` · ${spec.kinds.find((k) => k.value === kind)?.label.toLowerCase()}`}
          {search.trim() && ' · search'}
        </span>

        <span className="view-actions [display:flex] [align-items:center] [gap:8px] [margin-left:auto]">
          <Button
            variant="secondary"
            className="btn btn-small [padding:4px_10px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed] [font-size:12px]"
            onClick={onClearChat}
            disabled={items === 0}
            title="Clear every row from the feed"
          >
            Clear
          </Button>

          <span className="font-hint [color:var(--muted)] [font-size:11px] [font-variant-numeric:tabular-nums]" title="Ctrl + scroll anywhere in the window">
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

  return <span className="live-timer [padding:3px_8px] [border:1px_solid_color-mix(in_srgb,_var(--green)_34%,_transparent)] [border-radius:999px] [background:color-mix(in_srgb,_var(--green)_9%,_transparent)] [color:var(--green)] [font-size:10px] [font-variant-numeric:tabular-nums] [font-weight:700] [letter-spacing:0.04em]" title="Time connected to the live stream">LIVE {time}</span>
}
