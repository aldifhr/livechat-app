import { useEffect, useState } from 'react'
import { host } from '../lib/sidecar'
import { PLATFORM, PLATFORMS } from '../lib/platforms'
import { isReady, normaliseBaseUrl, type BackendConfig, type EventSource } from '../lib/backend'
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
  onFiltersChange: (filters: Partial<FeedFilters>) => void
  onCollapseChange: (enabled: boolean) => void
  onClear: () => void
  onSourceChange: (source: EventSource) => void
  onOpenLlm: () => void
  onOpenBackend: () => void
}

const TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'compact', label: 'Compact', hint: 'One line per message, no avatars' },
  { key: 'hideJoins', label: 'Hide joins', hint: 'Drop "X joined the stream" rows' },
  { key: 'hideFiltered', label: 'Hide filtered', hint: 'Drop messages TikTok already filtered' },
  { key: 'alwaysOnTop', label: 'On top', hint: 'Keep the window above others' },
  { key: 'giftSound', label: 'Gift sound', hint: 'Chime when a gift arrives' },
  { key: 'giftNotice', label: 'Gift notice', hint: 'Raise a desktop toast when a gift arrives' },
  { key: 'showOverlay', label: 'Overlay', hint: 'Open a transparent window for gifts and likes' },
]

/** Only meaningful while the overlay is up: a hidden window cannot pass clicks. */
const CONDITIONAL_TOGGLES: {
  key: keyof ViewSettings
  label: string
  hint: string
  needs: keyof ViewSettings
}[] = [
  { key: 'overlayClickThrough', label: 'Click-through', hint: 'Let clicks fall past the overlay', needs: 'showOverlay' },
]

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
  onSourceChange,
  onOpenLlm,
  onOpenBackend,
}: Props) {
  const spec = PLATFORMS[PLATFORM]
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [storedBackend, setStoredBackend] = useState<BackendConfig>(backend)

  useEffect(() => setStoredBackend(backend), [backend])

  // Held here rather than in App: switching source and pressing Connect are one
  // decision, and splitting them across two components is how a Connect ends up
  // talking to a socket that is no longer the one being shown.
  const fromBackend = settings.eventSource === 'backend'
  const isConnecting = busy || room.status === 'connecting'
  const isConnected = room.status === 'connected'
  const backendReady = isReady(storedBackend)

  async function connectBridge() {
    const value = target.trim()
    if (!value) return
    setBusy(true)
    onClear()
    try {
      await host.connect(PLATFORM, value)
    } finally {
      setBusy(false)
    }
  }

  async function disconnectBridge() {
    setBusy(true)
    try {
      await host.disconnect(PLATFORM)
    } finally {
      setBusy(false)
    }
  }

  async function connectBackend() {
    setBusy(true)
    onClear()
    try {
      await host.backendConnect({ ...storedBackend, baseUrl: normaliseBaseUrl(storedBackend.baseUrl) })
    } catch {
      // The host refuses an unconfigured backend, and says why in its rejection.
      // The status line picks that up; this only has to not leave the button stuck
      // on "Connecting…" for ever.
      setBusy(false)
      return
    }
    setBusy(false)
  }

  async function disconnectBackend() {
    setBusy(true)
    try {
      await host.backendDisconnect()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="toolbar">
      <div className="source-row" role="group" aria-label="Where the chat comes from">
        {(['bridge', 'backend'] as EventSource[]).map((source) => (
          <button
            key={source}
            className={`chip chip-small${fromBackend === (source === 'backend') ? ' chip-active' : ''}`}
            aria-pressed={fromBackend === (source === 'backend')}
            title={
              source === 'bridge'
                ? 'Run the local bridge in this app — needs nothing else running'
                : 'Read from a StreamKit backend — no 85 MB bridge, but it has to be up'
            }
            onClick={() => onSourceChange(source)}
          >
            {source === 'bridge' ? 'Bridge' : 'Backend'}
          </button>
        ))}
        <button className="btn btn-small llm-btn" onClick={onOpenBackend} title="Backend address and overlay">
          {fromBackend ? 'Configure…' : 'Set up…'}
        </button>
      </div>

      <div className="room-row">
        {fromBackend ? (
          // No username field: the backend decides which room to read, and there
          // is nothing this app could type that would change that.
          <>
            <span className="source-note">
              {backendReady ? (
                <>
                  Reading <strong>{storedBackend.overlayId.slice(0, 8)}</strong> from{' '}
                  {normaliseBaseUrl(storedBackend.baseUrl)}
                </>
              ) : (
                'Backend is not set up yet'
              )}
            </span>
            {isConnected ? (
              <button className="btn btn-danger" onClick={disconnectBackend}>
                Stop
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={connectBackend}
                disabled={!backendReady || isConnecting}
              >
                {isConnecting ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </>
        ) : (
          <>
            <input
              className="input"
              placeholder={spec.placeholder}
              aria-label={`${spec.label} ${spec.targetLabel}`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isConnecting && target.trim()) connectBridge()
              }}
              disabled={isConnecting || isConnected}
            />
            {isConnected ? (
              <button className="btn btn-danger" onClick={disconnectBridge}>
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" onClick={connectBridge} disabled={!target.trim() || isConnecting}>
                {isConnecting ? 'Connecting…' : 'Connect'}
              </button>
            )}
            {room.status === 'connected' && room.target && (
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
          </>
        )}

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
    </div>
  )
}