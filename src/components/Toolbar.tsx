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
}

const TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'giftSound', label: 'Gift sound', hint: 'Chime when a gift arrives' },
  { key: 'giftNotice', label: 'Gift notice', hint: 'Raise a desktop toast when a gift arrives' },
]

const CONDITIONAL_TOGGLES: {
  key: keyof ViewSettings
  label: string
  hint: string
  needs: keyof ViewSettings
}[] = [
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
}: Props) {
  const spec = PLATFORMS[PLATFORM]
  const [busy, setBusy] = useState(false)
  // Seeded once from what was saved, then the user's to edit: re-deriving it on
  // every render would undo half-typed handles under the cursor.
  const [handle, setHandle] = useState(() => normaliseUsername(backend.username))
  const savedHandle = useRef(normaliseUsername(backend.username))

  const isConnecting = busy || room.status === 'connecting'
  const isConnected = room.status === 'connected'
  const wanted = normaliseUsername(handle)
  const canConnect = wanted !== '' && !isConnecting

  /*
    Remembered as soon as it stops changing, not on connect: being made to
    reconnect to save a handle is the same as not remembering it. Debounced
    because a save per keystroke is a write per keystroke, and `savedHandle`
    stops the timer mattering once it has landed.
  */
  useEffect(() => {
    if (!wanted || wanted === savedHandle.current) return
    const timer = setTimeout(() => {
      savedHandle.current = wanted
      host.backendConfigSave({ baseUrl: backendUrl(backend), username: wanted }).catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [wanted, backend])

  async function connect() {
    setBusy(true)
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
          {wanted ? (
            <>
              <strong>@{wanted}</strong> via {backendUrl(backend).replace(/^https?:\/\//, '')}
            </>
          ) : (
            'Type the handle to start'
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
        {CONDITIONAL_TOGGLES.filter((option) => settings[option.needs]).map((option) => (
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