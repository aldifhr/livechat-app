import { useEffect, useRef, useState } from 'react'
import { host } from '../lib/sidecar'
import { PLATFORM, PLATFORMS } from '../lib/platforms'
import { backendUrl, normaliseUsername, type BackendConfig } from '../lib/backend'
import type { FeedFilters, KindFilter } from '../hooks/useVisibleItems'
import type { Health } from '../hooks/useHealth'
import type { UseSettingsResult, ViewSettings } from '../hooks/useSettings'
import { DENSITIES, FONTS, THEMES } from '../lib/theme'
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
  onFiltersChange: (filters: Partial<FeedFilters>) => void
  onCollapseChange: (enabled: boolean) => void
  onClear: () => void
  onOpenLlm: () => void
}

const TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'compact', label: 'Compact', hint: 'One line per message, no avatars' },
  { key: 'hideJoins', label: 'Hide joins', hint: 'Drop "X joined the stream" rows' },
  { key: 'hideFiltered', label: 'Hide filtered', hint: 'Drop messages TikTok already filtered' },
  { key: 'alwaysOnTop', label: 'On top', hint: 'Keep the window above others' },
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
  onFiltersChange,
  onCollapseChange,
  onClear,
  onOpenLlm,
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
    onClear()
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
        Collapse spam lives here rather than beside the search box. It is a
        reading preference, like everything else on this row, and it sat on a row
        of its own that pushed the search field below the fold in a window of
        ordinary size.
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

        {/* Moved up onto the toggle row: it said the same thing as the active chip
            and the search box beside it, and a row of its own was the one the
            window could least afford. */}
        <span className="summary">
          {totalReceived.toLocaleString()} events
          {kind !== 'all' && ` · ${spec.kinds.find((k) => k.value === kind)?.label.toLowerCase()}`}
          {search.trim() && ' · search'}
        </span>

        <button className="btn btn-small llm-btn" onClick={onOpenLlm} title="Point the app at a model">
          Model
        </button>
        <span className="font-hint" title="Ctrl + scroll anywhere in the window">
          {Math.round(settings.fontScale * 100)}%
        </span>
      </div>

      {/*
        The look controls, on a row of their own rather than crowded onto the
        toggles: they are three selects that label themselves, and a select
        beside a checkbox reads as the same kind of control when it is not. Each
        writes straight into settings, which persists it and applies the body
        attribute — the switcher holds no state of its own.
      */}
      <div className="look-row">
        <label className="look-field">
          <span className="look-label">Theme</span>
          <select
            className="input"
            value={settings.theme}
            onChange={(e) => settings.set('theme', e.target.value as ViewSettings['theme'])}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id} title={t.hint}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="look-field">
          <span className="look-label">Font</span>
          <select
            className="input"
            value={settings.font}
            onChange={(e) => settings.set('font', e.target.value as ViewSettings['font'])}
          >
            {FONTS.map((f) => (
              <option key={f.id} value={f.id} title={f.hint}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="look-field">
          <span className="look-label">Density</span>
          <select
            className="input"
            value={settings.density}
            onChange={(e) => settings.set('density', e.target.value as ViewSettings['density'])}
          >
            {DENSITIES.map((d) => (
              <option key={d.id} value={d.id} title={d.hint}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}