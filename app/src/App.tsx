import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { FeedRow } from './components/FeedRow'
import { EventPopup } from './components/EventPopup'
import { AnimatedListItem } from './components/ui/animated-list'
import { LogPanel } from './components/LogPanel'
import { SettingsPage } from './components/SettingsPage'
import { SimulatorDialog } from './components/SimulatorDialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './components/ui/empty'
import { StatsPanel } from './components/StatsPanel'
import { VipQueuePage } from './components/VipQueuePage'
import { GiveawayPage } from './components/GiveawayPage'
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

type AppPage = 'home' | 'stats' | 'vip' | 'giveaway' | 'log' | 'test' | 'settings'

// Runtime theme variations are still emitted as Tailwind utilities. Keeping the
// selector utilities in this literal lets Tailwind see every class at compile
// time while the selected skin remains a normal setting.
const BRUTALISM_CLASSES = [
  '[font-family:Arial_Black,Helvetica_Neue,Impact,sans-serif]', '[font-weight:700]', '[letter-spacing:-0.01em]',
  '[&_.toolbar]:[border-top:4px_solid_#000]', '[&_.toolbar]:[border-bottom:4px_solid_#000]',
  '[&_.log-panel]:[border-top:4px_solid_#000]', '[&_.log-panel]:[border-bottom:4px_solid_#000]',
  '[&_.ask-panel]:[border-top:4px_solid_#000]', '[&_.ask-panel]:[border-bottom:4px_solid_#000]',
  '[&_.btn]:[border:3px_solid_#000]', '[&_.btn]:[border-radius:0]', '[&_.btn]:[box-shadow:4px_4px_0_#000]',
  '[&_.btn]:[text-transform:uppercase]', '[&_.btn]:[font-weight:900]',
  '[&_.btn:hover:not(:disabled)]:[border-color:#000]', '[&_.btn:hover:not(:disabled)]:[transform:translate(-1px,-1px)]', '[&_.btn:hover:not(:disabled)]:[box-shadow:5px_5px_0_#000]',
  '[&_.btn:active:not(:disabled)]:[transform:translate(3px,3px)]', '[&_.btn:active:not(:disabled)]:[box-shadow:1px_1px_0_#000]',
  '[&_.btn:disabled]:[box-shadow:none]', '[&_.btn:disabled]:[opacity:0.5]',
  '[&_.btn-primary]:[background:var(--accent)]', '[&_.btn-primary]:[color:#fff]',
  '[&_.btn-danger]:[background:#fff]', '[&_.btn-danger]:[color:#000]', '[&_.btn-danger]:[border-color:#000]',
  '[&_.input]:[border:3px_solid_#000]', '[&_.input]:[border-radius:0]', '[&_.input]:[background:#fff]', '[&_.input]:[color:#000]', '[&_.input]:[font-weight:700]',
  '[&_.input:focus]:[outline:3px_solid_var(--accent)]', '[&_.input:focus]:[outline-offset:1px]',
  '[&_.row]:[border:3px_solid_#000]', '[&_.row]:[border-radius:0]', '[&_.row]:[margin-bottom:6px]', '[&_.row]:[background:#fff]',
  '[&_.row-new]:[box-shadow:none]', '[&_.row-new]:[background:var(--panel-2)]', '[&_.row-new]:[border-color:#000]',
  '[&_.avatar]:[border-radius:0]', '[&_.avatar]:[border:3px_solid_#000]', '[&_.avatar-fallback]:[border-radius:0]', '[&_.avatar-fallback]:[border:3px_solid_#000]',
  '[&_.nickname]:[text-transform:uppercase]', '[&_.nickname]:[font-weight:900]',
  '[&_.chip]:[border:3px_solid_#000]', '[&_.chip]:[border-radius:0]', '[&_.chip]:[box-shadow:3px_3px_0_#000]',
  '[&_.chip-active]:[background:var(--panel-2)]', '[&_.chip-active]:[color:#000]',
  '[&_.status_.dot]:[border-radius:0]', '[&_.status_.dot]:[width:12px]', '[&_.status_.dot]:[height:12px]', '[&_.status_.dot]:[border:2px_solid_#000]',
  '[&_.badge-mod]:[background:#ffe600]', '[&_.badge-mod]:[color:#000]', '[&_.badge-mod]:[border:2px_solid_#000]', '[&_.badge-mod]:[border-radius:0]',
  '[&_.badge-filtered]:[border:2px_solid_#000]', '[&_.badge-filtered]:[border-radius:0]', '[&_.badge-filtered]:[background:#fff]', '[&_.badge-filtered]:[color:#000]',
  '[&_.modal]:[border:4px_solid_#000]', '[&_.modal]:[border-radius:0]', '[&_.modal]:[box-shadow:10px_10px_0_#000]',
  '[&_.jump]:[border:3px_solid_#000]', '[&_.jump]:[border-radius:0]', '[&_.jump]:[box-shadow:4px_4px_0_#000]', '[&_.jump]:[color:#fff]', '[&_.jump]:[text-transform:uppercase]',
].join(' ')

const BASE_THEME_CLASSES = [
  '[--bg:#000]', '[--panel:#101010]', '[--panel-2:#1a1a1a]', '[--line:#303030]',
  '[--text:#f5f5f5]', '[--muted:#a3a3a3]', '[--accent:#f5f5f5]', '[--accent-soft:rgba(255,255,255,0.14)]',
  '[--gold:#d4af37]', '[--green:#22c55e]', '[--follow:#f472b6]', '[--share:#38bdf8]',
  '[--destructive:#ef4444]', '[--radius:10px]',
].join(' ')

function ConnectGate() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-5">
      <div className="w-full max-w-[520px] rounded-xl border border-line bg-panel p-8 text-center">
        <h2 className="m-0 mb-2 text-lg font-semibold text-text">Connect to a stream first</h2>
        <p className="m-0 text-sm text-muted">
          This feature needs an active stream connection. Enter a TikTok handle
          and press Connect to get started.
        </p>
      </div>
    </main>
  )
}

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
    giftVoice: settings.giftVoice,
    followVoice: settings.followVoice,
    shareVoice: settings.shareVoice,
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

  const isConnected = room.status === 'connected'

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
      if (e.deltaY === 0) return
      e.preventDefault()
      nudgeFontScale(e.deltaY > 0 ? -0.05 : 0.05)
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', onWheel, true)
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

  useEffect(() => {
    if (settings.autoScrollMode !== 'always') return
    pinned.current = true
    setUnseen(0)
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [settings.autoScrollMode])

  return (
    <div
      className={`app flex h-full flex-col bg-app-bg text-sm leading-[1.5] text-app-text ${settings.font === 'mono' ? 'font-mono' : 'font-sans'} ${settings.theme === 'brutalism' ? `${BRUTALISM_CLASSES} [--bg:#f4f1e8] [--panel:#fff] [--panel-2:#ffe600] [--line:#000] [--text:#000] [--muted:#555] [--accent:#ff2e00] [--accent-soft:rgba(255,46,0,0.16)] [--gold:#000] [--green:#00c] [--destructive:#c00] [--radius:0px] [color-scheme:light]` : `${BASE_THEME_CLASSES} [color-scheme:dark]`} ${settings.density === 'compact' ? '[--gap:4px] [--pad-x:8px] [--pad-y:2px]' : settings.density === 'roomy' ? '[--gap:14px] [--pad-x:22px] [--pad-y:14px]' : '[--gap:8px] [--pad-x:14px] [--pad-y:8px]'}`}
      style={{ '--feed-font-scale': settings.fontScale } as CSSProperties}
    >
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

        <div className="feed-wrap [position:relative] [flex:1_1_auto] [display:flex] [min-height:120px]">
        <div
          className="feed flex-[1_1_auto] overflow-y-auto px-5 pt-3 pb-6 [scrollbar-width:thin] [font-size:calc(14px_*_var(--feed-font-scale))]"
          ref={listRef}
          onScroll={(e) => {
            const node = e.currentTarget
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
            const alwaysFollow = settings.autoScrollMode === 'always'
            pinned.current = alwaysFollow || atBottom
            // Reaching the bottom by hand counts as having seen everything.
            if (atBottom || alwaysFollow) setUnseen(0)
          }}
        >
          {visible.length === 0 ? (
            <Empty className="empty h-full gap-1.5 border-0 p-0">
              <EmptyHeader className="empty-header gap-1.5">
              <EmptyTitle className="empty-title m-0 text-base font-semibold">
                {room.status === 'connected' ? 'Waiting for chat…' : 'No messages yet'}
              </EmptyTitle>
              <EmptyDescription className="empty-hint m-0 max-w-[42ch] text-app-muted">
                {items.length > 0
                  ? 'No messages match the current filter.'
                  : 'Enter a username above and press Connect. The streamer has to be live.'}
              </EmptyDescription>
              </EmptyHeader>
            </Empty>
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
          <button className="jump [position:absolute] [left:50%] [bottom:12px] [transform:translateX(-50%)] [display:inline-flex] [align-items:center] [gap:6px] [padding:6px_14px] [background:var(--accent)] [border:0] [border-radius:999px] [color:var(--bg)] [font:inherit] [font-size:12px] [font-weight:600] [cursor:pointer] [box-shadow:0_2px_10px_rgba(0,_0,_0,_0.45)] [&:hover]:[filter:brightness(1.1)]" onClick={jumpToLatest}>
            {unseen.toLocaleString()} new {unseen === 1 ? 'message' : 'messages'} <span aria-hidden="true">▾</span>
          </button>
        )}
        </div>

      </>}

      {activePage === 'stats' && !isConnected && <ConnectGate />}
      {activePage === 'vip' && !isConnected && <ConnectGate />}
      {activePage === 'giveaway' && !isConnected && <ConnectGate />}
      {activePage === 'log' && !isConnected && <ConnectGate />}
      {activePage === 'test' && !isConnected && <ConnectGate />}
      {activePage === 'settings' && !isConnected && <ConnectGate />}

      {activePage === 'stats' && isConnected && (
        <main className="page-view stats-page [flex:1_1_auto] [min-height:0] [overflow:auto] [padding:20px] [&_.stats-panel]:[width:min(900px,_100%)] [&_.stats-panel]:[margin:0_auto] [&_.stats-panel]:[border:1px_solid_var(--line)] [&_.stats-panel]:[border-radius:var(--radius)] [&_.log-panel]:[width:min(900px,_100%)] [&_.log-panel]:[margin:0_auto] [&_.log-panel]:[border:1px_solid_var(--line)] [&_.log-panel]:[border-radius:var(--radius)] [&_.stats-body]:[max-height:none] [&_.stats-body]:[overflow:visible] [&_.log-panel]:[display:flex] [&_.log-panel]:[min-height:180px] [&_.log-panel]:[flex-direction:column] [&_.log-list]:[flex:1_1_auto] [&_.log-list]:[max-height:none] [&_.log-list]:[min-height:120px]">
          <header className="page-view-head [margin:0_auto_18px] [width:min(900px,_100%)] [&_h1]:[margin:0] [&_h1]:[font-size:20px] [&_p]:[margin:4px_0_0] [&_p]:[color:var(--muted)] [&_p]:[font-size:12px]">
            <h1>Stream stats</h1>
            <p>Session totals and activity from the connected stream.</p>
          </header>
          <StatsPanel stats={stats} />
        </main>
      )}

      {activePage === 'vip' && isConnected && <VipQueuePage items={items} />}
      {activePage === 'giveaway' && isConnected && <GiveawayPage stats={stats} items={items} active={activePage === 'giveaway'} connected={room.status === 'connected'} streamer={room.target} />}

      {activePage === 'log' && isConnected && (
        <main className="page-view log-page [flex:1_1_auto] [min-height:0] [overflow:auto] [padding:20px] [&_.stats-panel]:[width:min(900px,_100%)] [&_.stats-panel]:[margin:0_auto] [&_.stats-panel]:[border:1px_solid_var(--line)] [&_.stats-panel]:[border-radius:var(--radius)] [&_.log-panel]:[width:min(900px,_100%)] [&_.log-panel]:[margin:0_auto] [&_.log-panel]:[border:1px_solid_var(--line)] [&_.log-panel]:[border-radius:var(--radius)] [&_.stats-body]:[max-height:none] [&_.stats-body]:[overflow:visible] [&_.log-panel]:[display:flex] [&_.log-panel]:[min-height:180px] [&_.log-panel]:[flex-direction:column] [&_.log-list]:[flex:1_1_auto] [&_.log-list]:[max-height:none] [&_.log-list]:[min-height:120px]">
          <header className="page-view-head [margin:0_auto_18px] [width:min(900px,_100%)] [&_h1]:[margin:0] [&_h1]:[font-size:20px] [&_p]:[margin:4px_0_0] [&_p]:[color:var(--muted)] [&_p]:[font-size:12px]">
            <h1>Event log</h1>
            <p>Connection updates and bridge diagnostics.</p>
          </header>
          <LogPanel entries={log.entries} tallies={log.tallies} onClear={log.clear} />
        </main>
      )}

      {activePage === 'test' && isConnected && (
        <SimulatorDialog open inline onClose={() => setActivePage('home')} />
      )}

      {activePage === 'settings' && isConnected && <SettingsPage settings={settings} />}

      {activePage === 'home' && (
        <EventPopup
          enabled={{ gift: settings.giftPopup, follow: settings.followPopup, share: settings.sharePopup }}
          giftDurationSeconds={settings.giftPopupDurationSeconds}
          giftSize={settings.giftPopupSize}
          giftPosition={settings.giftPopupPosition}
        />
      )}

      <nav className="app-dock-wrap flex w-full flex-none justify-center px-0 pb-2" aria-label="App pages">
        <Dock className="app-dock mt-0 h-[58px] max-w-full gap-1 rounded-2xl border-app-line bg-app-panel px-2 py-2 shadow-[0_4px_18px_rgba(0,0,0,0.3)] [&_.dock-action]:[width:56px]" iconSize={56} iconMagnification={56} iconDistance={100}>
          <DockIcon>
            <button className="dock-action [display:flex] [flex-direction:column] [width:72px] [height:46px] [flex:0_0_auto] [align-items:center] [justify-content:center] [gap:1px] [padding:0] [border:1px_solid_transparent] [border-radius:13px] [background:transparent] [color:var(--muted)] [font:inherit] [font-weight:500] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease,_border-color_140ms_ease,_transform_140ms_ease] [&:hover]:[outline:none] [&:hover]:[border-color:var(--line)] [&:hover]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:hover]:[color:var(--accent)] [&:hover]:[transform:translateY(-2px)] [&:focus-visible]:[outline:none] [&:focus-visible]:[border-color:var(--line)] [&:focus-visible]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:focus-visible]:[color:var(--accent)] [&:focus-visible]:[transform:translateY(-2px)] [&[aria-current=page]]:[position:relative] [&[aria-current=page]]:[border-color:transparent] [&[aria-current=page]]:[background:color-mix(in_srgb,_var(--gold)_10%,_var(--panel))] [&[aria-current=page]]:[color:var(--gold)] [&[aria-current=page]]:[box-shadow:none] [&[aria-current=page]::after]:[position:absolute] [&[aria-current=page]::after]:[bottom:2px] [&[aria-current=page]::after]:[width:18px] [&[aria-current=page]::after]:[height:2px] [&[aria-current=page]::after]:[border-radius:999px] [&[aria-current=page]::after]:[background:var(--gold)] [&[aria-current=page]::after]:[content:'']" type="button" title="Home" aria-label="Home" aria-current={activePage === 'home' ? 'page' : undefined} onClick={() => setActivePage('home')}>
              <span className="dock-glyph [display:grid] [width:22px] [height:22px] [place-items:center] [&_svg]:[width:19px] [&_svg]:[height:19px] [&_svg]:[fill:none] [&_svg]:[stroke:currentColor] [&_svg]:[stroke-width:1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3.5 10 8.5-7 8.5 7M5.5 9v11h13V9M9.5 20v-6h5v6" /></svg></span>
              <span className="dock-label [font-size:10px] [line-height:1.1] [letter-spacing:0.01em]">Home</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button className="dock-action [display:flex] [flex-direction:column] [width:72px] [height:46px] [flex:0_0_auto] [align-items:center] [justify-content:center] [gap:1px] [padding:0] [border:1px_solid_transparent] [border-radius:13px] [background:transparent] [color:var(--muted)] [font:inherit] [font-weight:500] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease,_border-color_140ms_ease,_transform_140ms_ease] [&:hover]:[outline:none] [&:hover]:[border-color:var(--line)] [&:hover]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:hover]:[color:var(--accent)] [&:hover]:[transform:translateY(-2px)] [&:focus-visible]:[outline:none] [&:focus-visible]:[border-color:var(--line)] [&:focus-visible]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:focus-visible]:[color:var(--accent)] [&:focus-visible]:[transform:translateY(-2px)] [&[aria-current=page]]:[position:relative] [&[aria-current=page]]:[border-color:transparent] [&[aria-current=page]]:[background:color-mix(in_srgb,_var(--gold)_10%,_var(--panel))] [&[aria-current=page]]:[color:var(--gold)] [&[aria-current=page]]:[box-shadow:none] [&[aria-current=page]::after]:[position:absolute] [&[aria-current=page]::after]:[bottom:2px] [&[aria-current=page]::after]:[width:18px] [&[aria-current=page]::after]:[height:2px] [&[aria-current=page]::after]:[border-radius:999px] [&[aria-current=page]::after]:[background:var(--gold)] [&[aria-current=page]::after]:[content:'']" type="button" title="VIP Queue" aria-label="VIP Mabar Queue page" aria-current={activePage === 'vip' ? 'page' : undefined} onClick={() => setActivePage('vip')}>
              <span className="dock-glyph [display:grid] [width:22px] [height:22px] [place-items:center] [&_svg]:[width:19px] [&_svg]:[height:19px] [&_svg]:[fill:none] [&_svg]:[stroke:currentColor] [&_svg]:[stroke-width:1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 2.4 5 5.5.8-4 3.9.9 5.5-4.8-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8L12 3Z" /></svg></span>
              <span className="dock-label [font-size:10px] [line-height:1.1] [letter-spacing:0.01em]">VIP</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button className="dock-action [display:flex] [flex-direction:column] [width:72px] [height:46px] [flex:0_0_auto] [align-items:center] [justify-content:center] [gap:1px] [padding:0] [border:1px_solid_transparent] [border-radius:13px] [background:transparent] [color:var(--muted)] [font:inherit] [font-weight:500] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease,_border-color_140ms_ease,_transform_140ms_ease] [&:hover]:[outline:none] [&:hover]:[border-color:var(--line)] [&:hover]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:hover]:[color:var(--accent)] [&:hover]:[transform:translateY(-2px)] [&:focus-visible]:[outline:none] [&:focus-visible]:[border-color:var(--line)] [&:focus-visible]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:focus-visible]:[color:var(--accent)] [&:focus-visible]:[transform:translateY(-2px)] [&[aria-current=page]]:[position:relative] [&[aria-current=page]]:[border-color:transparent] [&[aria-current=page]]:[background:color-mix(in_srgb,_var(--gold)_10%,_var(--panel))] [&[aria-current=page]]:[color:var(--gold)] [&[aria-current=page]]:[box-shadow:none] [&[aria-current=page]::after]:[position:absolute] [&[aria-current=page]::after]:[bottom:2px] [&[aria-current=page]::after]:[width:18px] [&[aria-current=page]::after]:[height:2px] [&[aria-current=page]::after]:[border-radius:999px] [&[aria-current=page]::after]:[background:var(--gold)] [&[aria-current=page]::after]:[content:'']" type="button" title="Giveaway Picker" aria-label="Giveaway picker page" aria-current={activePage === 'giveaway' ? 'page' : undefined} onClick={() => setActivePage('giveaway')}>
              <span className="dock-glyph [display:grid] [width:22px] [height:22px] [place-items:center] [&_svg]:[width:19px] [&_svg]:[height:19px] [&_svg]:[fill:none] [&_svg]:[stroke:currentColor] [&_svg]:[stroke-width:1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 4h12v3a6 6 0 0 1-12 0V4Z" /><path d="M6 6H3v1a4 4 0 0 0 4 4M18 6h3v1a4 4 0 0 1-4 4M12 13v5m-4 3h8m-7-3h6" /></svg></span>
              <span className="dock-label [font-size:10px] [line-height:1.1] [letter-spacing:0.01em]">Draw</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button
              className="dock-action [display:flex] [flex-direction:column] [width:72px] [height:46px] [flex:0_0_auto] [align-items:center] [justify-content:center] [gap:1px] [padding:0] [border:1px_solid_transparent] [border-radius:13px] [background:transparent] [color:var(--muted)] [font:inherit] [font-weight:500] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease,_border-color_140ms_ease,_transform_140ms_ease] [&:hover]:[outline:none] [&:hover]:[border-color:var(--line)] [&:hover]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:hover]:[color:var(--accent)] [&:hover]:[transform:translateY(-2px)] [&:focus-visible]:[outline:none] [&:focus-visible]:[border-color:var(--line)] [&:focus-visible]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:focus-visible]:[color:var(--accent)] [&:focus-visible]:[transform:translateY(-2px)] [&[aria-current=page]]:[position:relative] [&[aria-current=page]]:[border-color:transparent] [&[aria-current=page]]:[background:color-mix(in_srgb,_var(--gold)_10%,_var(--panel))] [&[aria-current=page]]:[color:var(--gold)] [&[aria-current=page]]:[box-shadow:none] [&[aria-current=page]::after]:[position:absolute] [&[aria-current=page]::after]:[bottom:2px] [&[aria-current=page]::after]:[width:18px] [&[aria-current=page]::after]:[height:2px] [&[aria-current=page]::after]:[border-radius:999px] [&[aria-current=page]::after]:[background:var(--gold)] [&[aria-current=page]::after]:[content:'']"
              type="button"
              title="Stats"
              aria-label="Stats page"
              aria-current={activePage === 'stats' ? 'page' : undefined}
              onClick={() => setActivePage('stats')}
            >
              <span className="dock-glyph [display:grid] [width:22px] [height:22px] [place-items:center] [&_svg]:[width:19px] [&_svg]:[height:19px] [&_svg]:[fill:none] [&_svg]:[stroke:currentColor] [&_svg]:[stroke-width:1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16M8 16v-5M12 16V7M16 16v-8M20 16v-4" /></svg></span>
              <span className="dock-label [font-size:10px] [line-height:1.1] [letter-spacing:0.01em]">Stats</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button
              className="dock-action [display:flex] [flex-direction:column] [width:72px] [height:46px] [flex:0_0_auto] [align-items:center] [justify-content:center] [gap:1px] [padding:0] [border:1px_solid_transparent] [border-radius:13px] [background:transparent] [color:var(--muted)] [font:inherit] [font-weight:500] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease,_border-color_140ms_ease,_transform_140ms_ease] [&:hover]:[outline:none] [&:hover]:[border-color:var(--line)] [&:hover]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:hover]:[color:var(--accent)] [&:hover]:[transform:translateY(-2px)] [&:focus-visible]:[outline:none] [&:focus-visible]:[border-color:var(--line)] [&:focus-visible]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:focus-visible]:[color:var(--accent)] [&:focus-visible]:[transform:translateY(-2px)] [&[aria-current=page]]:[position:relative] [&[aria-current=page]]:[border-color:transparent] [&[aria-current=page]]:[background:color-mix(in_srgb,_var(--gold)_10%,_var(--panel))] [&[aria-current=page]]:[color:var(--gold)] [&[aria-current=page]]:[box-shadow:none] [&[aria-current=page]::after]:[position:absolute] [&[aria-current=page]::after]:[bottom:2px] [&[aria-current=page]::after]:[width:18px] [&[aria-current=page]::after]:[height:2px] [&[aria-current=page]::after]:[border-radius:999px] [&[aria-current=page]::after]:[background:var(--gold)] [&[aria-current=page]::after]:[content:'']"
              type="button"
              title="Log"
              aria-label="Log page"
              aria-current={activePage === 'log' ? 'page' : undefined}
              onClick={() => setActivePage('log')}
            >
              <span className="dock-glyph [display:grid] [width:22px] [height:22px] [place-items:center] [&_svg]:[width:19px] [&_svg]:[height:19px] [&_svg]:[fill:none] [&_svg]:[stroke:currentColor] [&_svg]:[stroke-width:1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r=".75" /><circle cx="4.5" cy="12" r=".75" /><circle cx="4.5" cy="18" r=".75" /></svg></span>
              <span className="dock-label [font-size:10px] [line-height:1.1] [letter-spacing:0.01em]">Log</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button className="dock-action [display:flex] [flex-direction:column] [width:72px] [height:46px] [flex:0_0_auto] [align-items:center] [justify-content:center] [gap:1px] [padding:0] [border:1px_solid_transparent] [border-radius:13px] [background:transparent] [color:var(--muted)] [font:inherit] [font-weight:500] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease,_border-color_140ms_ease,_transform_140ms_ease] [&:hover]:[outline:none] [&:hover]:[border-color:var(--line)] [&:hover]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:hover]:[color:var(--accent)] [&:hover]:[transform:translateY(-2px)] [&:focus-visible]:[outline:none] [&:focus-visible]:[border-color:var(--line)] [&:focus-visible]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:focus-visible]:[color:var(--accent)] [&:focus-visible]:[transform:translateY(-2px)] [&[aria-current=page]]:[position:relative] [&[aria-current=page]]:[border-color:transparent] [&[aria-current=page]]:[background:color-mix(in_srgb,_var(--gold)_10%,_var(--panel))] [&[aria-current=page]]:[color:var(--gold)] [&[aria-current=page]]:[box-shadow:none] [&[aria-current=page]::after]:[position:absolute] [&[aria-current=page]::after]:[bottom:2px] [&[aria-current=page]::after]:[width:18px] [&[aria-current=page]::after]:[height:2px] [&[aria-current=page]::after]:[border-radius:999px] [&[aria-current=page]::after]:[background:var(--gold)] [&[aria-current=page]::after]:[content:'']" type="button" title="Test" aria-label="Event simulator page" aria-current={activePage === 'test' ? 'page' : undefined} onClick={() => setActivePage('test')}>
              <span className="dock-glyph [display:grid] [width:22px] [height:22px] [place-items:center] [&_svg]:[width:19px] [&_svg]:[height:19px] [&_svg]:[fill:none] [&_svg]:[stroke:currentColor] [&_svg]:[stroke-width:1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></svg></span>
              <span className="dock-label [font-size:10px] [line-height:1.1] [letter-spacing:0.01em]">Test</span>
            </button>
          </DockIcon>
          <DockIcon>
            <button className="dock-action [display:flex] [flex-direction:column] [width:72px] [height:46px] [flex:0_0_auto] [align-items:center] [justify-content:center] [gap:1px] [padding:0] [border:1px_solid_transparent] [border-radius:13px] [background:transparent] [color:var(--muted)] [font:inherit] [font-weight:500] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease,_border-color_140ms_ease,_transform_140ms_ease] [&:hover]:[outline:none] [&:hover]:[border-color:var(--line)] [&:hover]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:hover]:[color:var(--accent)] [&:hover]:[transform:translateY(-2px)] [&:focus-visible]:[outline:none] [&:focus-visible]:[border-color:var(--line)] [&:focus-visible]:[background:color-mix(in_srgb,_var(--accent)_9%,_var(--panel))] [&:focus-visible]:[color:var(--accent)] [&:focus-visible]:[transform:translateY(-2px)] [&[aria-current=page]]:[position:relative] [&[aria-current=page]]:[border-color:transparent] [&[aria-current=page]]:[background:color-mix(in_srgb,_var(--gold)_10%,_var(--panel))] [&[aria-current=page]]:[color:var(--gold)] [&[aria-current=page]]:[box-shadow:none] [&[aria-current=page]::after]:[position:absolute] [&[aria-current=page]::after]:[bottom:2px] [&[aria-current=page]::after]:[width:18px] [&[aria-current=page]::after]:[height:2px] [&[aria-current=page]::after]:[border-radius:999px] [&[aria-current=page]::after]:[background:var(--gold)] [&[aria-current=page]::after]:[content:'']" type="button" title="Settings" aria-label="Settings page" aria-current={activePage === 'settings' ? 'page' : undefined} onClick={() => setActivePage('settings')}>
              <span className="dock-glyph [display:grid] [width:22px] [height:22px] [place-items:center] [&_svg]:[width:19px] [&_svg]:[height:19px] [&_svg]:[fill:none] [&_svg]:[stroke:currentColor] [&_svg]:[stroke-width:1.7] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="M19.4 15.2a8 8 0 0 0 0-6.4l1.2-1-1.4-2.4-1.5.6a8 8 0 0 0-5.6-3.2L11.8 1h-2.8l-.3 1.8a8 8 0 0 0-5.1 3.4l-1.6-.6L.6 8l1.2 1a8 8 0 0 0 0 6.4l-1.2 1L2 18.8l1.6-.6a8 8 0 0 0 5.1 3.4l.3 1.8h2.8l.3-1.8a8 8 0 0 0 5.6-3.2l1.5.6 1.4-2.4-1.2-1Z" transform="translate(1 0) scale(.92)" /></svg></span>
              <span className="dock-label [font-size:10px] [line-height:1.1] [letter-spacing:0.01em]">Settings</span>
            </button>
          </DockIcon>
        </Dock>
      </nav>
    </div>
  )
}
