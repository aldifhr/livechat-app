import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FeedRow } from './components/FeedRow'
import { EventPopup } from './components/EventPopup'
import { AnimatedListItem } from './components/ui/animated-list'
import { LogPanel } from './components/LogPanel'
import { SettingsPage } from './components/SettingsPage'
import { SimulatorDialog } from './components/SimulatorDialog'
import { StatsPanel } from './components/StatsPanel'
import { Toolbar } from './components/Toolbar'
import { Dock, DockIcon } from './components/ui/dock'

import { useAutoReply } from './hooks/useAutoReply'
import { useChat } from './hooks/useChat'
import { useChatAlerts } from './hooks/useChatAlerts'
import { useGiftNotification } from './hooks/useGiftNotification'
import { useGiftSound } from './hooks/useGiftSound'
import { useJoinSound } from './hooks/useJoinSound'
import { useEventSound } from './hooks/useEventSound'

import { useSettings } from './hooks/useSettings'
import { useKindCounts, useVisibleItems, type FeedFilters } from './hooks/useVisibleItems'
import { EMPTY_BACKEND, type BackendConfig } from './lib/backend'
import { host } from './lib/sidecar'
import type { VoiceOptions } from './lib/voices'

type AppPage = 'home' | 'stats' | 'log' | 'test' | 'settings'

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>('home')
  const [backend, setBackend] = useState<BackendConfig>(EMPTY_BACKEND)
  const [liveSince, setLiveSince] = useState<number | null>(null)
  const [filters, setFilters] = useState<FeedFilters>({ kind: 'all', search: '' })
  const settings = useSettings()
  const { nudgeFontScale } = settings

  // Memoised, because it is handed to three hooks with dependency arrays and a
  // fresh object literal would be a changed value on every message arriving — the
  // same churn `useSettings` memoises its own result to avoid. Spelled out on the
  // fields rather than on the object so changing the pace re-runs the hooks and
  // changing anything else does not.
  const voice = useMemo<VoiceOptions>(
    () => ({ pace: settings.ttsPace, language: settings.ttsLanguage, volume: settings.ttsVolume }),
    [settings.ttsPace, settings.ttsLanguage, settings.ttsVolume],
  )

  useGiftSound({
    enabled: settings.giftSound,
    templateId: settings.giftTemplate,
    customPath: settings.giftSoundPath,
    volume: settings.giftSoundVolume,
    gapMs: settings.giftSoundGapMs,
  })
  useJoinSound({
    enabled: settings.joinSound,
    templateId: settings.joinTemplate,
    customPath: settings.joinSoundPath,
    volume: settings.joinSoundVolume,
    gapMs: settings.joinSoundGapMs,
  })
  useEventSound({ type: 'follow', enabled: settings.followSound, templateId: settings.followTemplate, customPath: settings.followSoundPath, volume: settings.followSoundVolume, gapMs: settings.followSoundGapMs })
  useEventSound({ type: 'share', enabled: settings.shareSound, templateId: settings.shareTemplate, customPath: settings.shareSoundPath, volume: settings.shareSoundVolume, gapMs: settings.shareSoundGapMs })
  useGiftNotification({
    notice: settings.giftNotice,
    voice: settings.giftVoice,
    speech: voice,
  })
  useAutoReply({ enabled: settings.autoReply })
  useChatAlerts({
    chatSound: settings.chatSound,
    chatTts: settings.chatTts,
    voice,
    templateId: settings.chatTemplate,
    customPath: settings.chatSoundPath,
    soundVolume: settings.chatSoundVolume,
    soundGapMs: settings.chatSoundGapMs,
  })

  const { room, items, totalReceived, clear, log, health, stats } = useChat({
    collapseWindowMs: 2500,
    // Only worth collapsing when a spam wave is actually running; two identical
    // messages in a row are usually just someone repeating themselves.
    collapseThreshold: settings.collapse ? 2 : 0,
  })

  useEffect(() => {
    if (room.status === 'connected') {
      setLiveSince((current) => current ?? Date.now())
    } else if (room.status !== 'connecting' && room.status !== 'waiting') {
      // A live timer runs only while a stream is being read, and survives a
      // reconnect. `waiting` is left alone for the same reason as `connecting`:
      // a source is still running, so this is a pause rather than an end.
      setLiveSince(null)
    }
  }, [room.status])

  // One filter, shared by the feed and the counters: what you see is what the
  // chips count.
  const visible = useVisibleItems(
    items,
    filters,
    { joins: settings.hideJoins, filtered: settings.hideFiltered },
  )
  const counts = useKindCounts(visible)

  // The backend's address, so the toolbar can name what it is about to read
  // before the user presses Connect. Read once: it changes only through the
  // dialog, which owns saving it.
  useEffect(() => {
    let active = true
    host
      .backendConfigGet()
      .then((saved) => {
        if (active) setBackend(saved)
      })
      .catch(() => {
        // An unconfigured backend is the default state, not a fault. The toolbar
        // says so when it matters.
      })
    return () => {
      active = false
    }
  }, [])

  // Ctrl+wheel resizes the feed. Bound on the window so it works wherever the
  // pointer is, and prevented so the browser does not zoom the whole UI too.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      nudgeFontScale(e.deltaY > 0 ? -0.1 : 0.1)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [nudgeFontScale])

  const listRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Arrivals the user has not seen yet, because they had scrolled up to read
  // something. Counted from the arrival total rather than the visible length: in a
  // busy room the list sits at its cap, so its length never changes and a
  // length-based counter would stay at zero exactly when the notice matters most.
  const [unseen, setUnseen] = useState(0)
  const arrivalsBefore = useRef(0)

  // Follow the tail while the user is at the bottom, and otherwise tell them how
  // much they missed. Scrolling up to read something must never be undone by the
  // next message arriving.
  useEffect(() => {
    const arrived = totalReceived - arrivalsBefore.current
    arrivalsBefore.current = totalReceived

    if (arrived <= 0) return

    if (pinned.current) {
      setUnseen(0)
      const node = listRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
      // Avatars, emotes and gift images are lazily loaded, so the height just
      // measured does not include them. Scrolling again once they land is what
      // keeps the newest row actually in view in an image-heavy room.
      const settle = window.setTimeout(() => {
        if (pinned.current) node.scrollTop = node.scrollHeight
      }, 250)
      return () => window.clearTimeout(settle)
    }
    setUnseen((count) => count + arrived)
  }, [totalReceived])

  const onFiltersChange = useCallback((next: Partial<FeedFilters>) => {
    setFilters((previous) => ({ ...previous, ...next }))
    // A filter that hides everything should not leave the list scrolled to the
    // bottom of nothing. The unseen count belongs to the old filter, so it goes too.
    pinned.current = true
    setUnseen(0)
  }, [])

  const jumpToLatest = useCallback(() => {
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
    pinned.current = true
    setUnseen(0)
  }, [])

  useEffect(() => {
    if (activePage !== 'home') return
    pinned.current = true
    setUnseen(0)
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [activePage])

  return (
    <div className="app flex h-full flex-col bg-app-bg text-app-text">
      {activePage === 'home' && <>
        <Toolbar
        room={room}
        liveSince={liveSince}
        counts={counts}
        totalReceived={totalReceived}
        kind={filters.kind}
        search={filters.search}
        health={health}
        settings={settings}
        backend={backend}
        onBackendChange={setBackend}
        items={items.length}
        onFiltersChange={onFiltersChange}
        onClearChat={clear}
        />

        <div className="feed-wrap">
        <div
          className="feed flex-[1_1_auto] overflow-y-auto px-5 pt-3 pb-6"
          ref={listRef}
          onScroll={(e) => {
            const node = e.currentTarget
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
            pinned.current = atBottom
            // Reaching the bottom by hand counts as having seen everything.
            if (atBottom) setUnseen(0)
          }}
          // Pause on hover: pointing at a message to read it must not be undone by
          // the next one arriving. The feed freezes while the pointer is over it and
          // resumes when it leaves — but only if it was still at the bottom, so
          // hovering a feed the streamer had already scrolled up does not yank it
          // back down. The same freeze scrolling up triggers, for the reader who
          // never touches the wheel.
          onMouseEnter={() => {
            pinned.current = false
          }}
          onMouseLeave={(e) => {
            const node = e.currentTarget
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
            // Resume following only from the bottom; a feed left scrolled up stays
            // put rather than jumping to the newest message on the way out.
            if (atBottom) {
              pinned.current = true
              setUnseen(0)
            }
          }}
        >
          {visible.length === 0 ? (
            <div className="empty">
              <p className="empty-title">
                {room.status === 'connected' ? 'Waiting for chat…' : 'No messages yet'}
              </p>
              <p className="empty-hint">
                {items.length > 0
                  ? 'No messages match the current filter.'
                  : 'Enter a username above and press Connect. The streamer has to be live.'}
              </p>
            </div>
          ) : (
            visible.map((item, index) => {
              const row = (
                <FeedRow
                  key={item.key}
                  item={item}
                  isLast={index === visible.length - 1}
                />
              )

              // Gifts get the same entrance animation as the Magic UI animated
              // list. Keep ordinary chat rows unwrapped so a busy feed stays light.
              return item.kind === 'gift' ? (
                <AnimatedListItem key={item.key}>{row}</AnimatedListItem>
              ) : row
            })
          )}
        </div>

        {unseen > 0 && (
          <button className="jump" onClick={jumpToLatest}>
            {unseen.toLocaleString()} new {unseen === 1 ? 'message' : 'messages'} <span aria-hidden="true">▾</span>
          </button>
        )}
        </div>

      </>}

      {activePage === 'stats' && (
        <main className="page-view stats-page">
          <header className="page-view-head">
            <h1>Stream stats</h1>
            <p>Session totals and activity from the connected stream.</p>
          </header>
          <StatsPanel stats={stats} />
        </main>
      )}

      {activePage === 'log' && (
        <main className="page-view log-page">
          <header className="page-view-head">
            <h1>Event log</h1>
            <p>Connection updates and bridge diagnostics.</p>
          </header>
          <LogPanel entries={log.entries} tallies={log.tallies} onClear={log.clear} />
        </main>
      )}

      {activePage === 'test' && (
        <SimulatorDialog open inline onClose={() => setActivePage('home')} />
      )}

      {activePage === 'settings' && <SettingsPage settings={settings} />}

      {activePage === 'home' && (
        <EventPopup enabled={{ gift: settings.giftPopup, follow: settings.followPopup, share: settings.sharePopup }} />
      )}

      <nav className="app-dock-wrap" aria-label="App pages">
        <Dock className="app-dock" iconSize={48} iconMagnification={56} iconDistance={120}>
          <DockIcon>
            <button className="dock-action" type="button" title="Home" aria-label="Home" aria-current={activePage === 'home' ? 'page' : undefined} onClick={() => setActivePage('home')}>
              <span className="dock-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3.5 10 8.5-7 8.5 7M5.5 9v11h13V9M9.5 20v-6h5v6" /></svg></span>
              <span className="dock-label">Home</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button
              className="dock-action"
              type="button"
              title="Stats"
              aria-label="Stats page"
              aria-current={activePage === 'stats' ? 'page' : undefined}
              onClick={() => setActivePage('stats')}
            >
              <span className="dock-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16M8 16v-5M12 16V7M16 16v-8M20 16v-4" /></svg></span>
              <span className="dock-label">Stats</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button
              className="dock-action"
              type="button"
              title="Log"
              aria-label="Log page"
              aria-current={activePage === 'log' ? 'page' : undefined}
              onClick={() => setActivePage('log')}
            >
              <span className="dock-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r=".75" /><circle cx="4.5" cy="12" r=".75" /><circle cx="4.5" cy="18" r=".75" /></svg></span>
              <span className="dock-label">Log</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button className="dock-action" type="button" title="Test" aria-label="Event simulator page" aria-current={activePage === 'test' ? 'page' : undefined} onClick={() => setActivePage('test')}>
              <span className="dock-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></svg></span>
              <span className="dock-label">Test</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button className="dock-action" type="button" title="Settings" aria-label="Settings page" aria-current={activePage === 'settings' ? 'page' : undefined} onClick={() => setActivePage('settings')}>
              <span className="dock-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="M19.4 15.2a8 8 0 0 0 0-6.4l1.2-1-1.4-2.4-1.5.6a8 8 0 0 0-5.6-3.2L11.8 1h-2.8l-.3 1.8a8 8 0 0 0-5.1 3.4l-1.6-.6L.6 8l1.2 1a8 8 0 0 0 0 6.4l-1.2 1L2 18.8l1.6-.6a8 8 0 0 0 5.1 3.4l.3 1.8h2.8l.3-1.8a8 8 0 0 0 5.6-3.2l1.5.6 1.4-2.4-1.2-1Z" transform="translate(1 0) scale(.92)" /></svg></span>
              <span className="dock-label">Settings</span>
            </button>
          </DockIcon>
        </Dock>
      </nav>
    </div>
  )
}
