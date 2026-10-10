import { useCallback, useEffect, useRef, useState } from 'react'
import { AskPanel } from './components/AskPanel'
import { BackendSettings } from './components/BackendSettings'
import { FeedRow } from './components/FeedRow'
import { LlmSettings } from './components/LlmSettings'
import { LogPanel } from './components/LogPanel'
import { StatsPanel } from './components/StatsPanel'
import { Toolbar } from './components/Toolbar'
import { useChat } from './hooks/useChat'
import { useGiftNotification } from './hooks/useGiftNotification'
import { useGiftSound } from './hooks/useGiftSound'
import { useSettings } from './hooks/useSettings'
import { useKindCounts, useVisibleItems, type FeedFilters } from './hooks/useVisibleItems'
import { EMPTY_BACKEND, type BackendConfig } from './lib/backend'
import { host } from './lib/sidecar'

export default function App() {
  const [collapse, setCollapse] = useState(true)
  const [llmOpen, setLlmOpen] = useState(false)
  const [backendOpen, setBackendOpen] = useState(false)
  const [backend, setBackend] = useState<BackendConfig>(EMPTY_BACKEND)
  const [filters, setFilters] = useState<FeedFilters>({ kind: 'all', search: '' })
  const settings = useSettings()

  useGiftSound(settings.giftSound)
  useGiftNotification(settings.giftNotice)

  const { room, items, totalReceived, clear, ask, asking, log, health, stats } = useChat({
    collapseWindowMs: 2500,
    // Only worth collapsing when a spam wave is actually running; two identical
    // messages in a row are usually just someone repeating themselves.
    collapseThreshold: collapse ? 2 : 0,
  })

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
      settings.nudgeFontScale(e.deltaY > 0 ? -0.1 : 0.1)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [settings])

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
      if (node) node.scrollTop = node.scrollHeight
    } else {
      setUnseen((count) => count + arrived)
    }
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

  return (
    <div className="app">
      <Toolbar
        room={room}
        counts={counts}
        totalReceived={totalReceived}
        kind={filters.kind}
        search={filters.search}
        collapse={collapse}
        health={health}
        settings={settings}
        backend={backend}
        onFiltersChange={onFiltersChange}
        onCollapseChange={setCollapse}
        onClear={clear}
        onOpenLlm={() => setLlmOpen(true)}
        onOpenBackend={() => setBackendOpen(true)}
      />

      <div className="feed-wrap">
        <div
          className="feed"
          ref={listRef}
          onScroll={(e) => {
            const node = e.currentTarget
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
            pinned.current = atBottom
            // Reaching the bottom by hand counts as having seen everything.
            if (atBottom) setUnseen(0)
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
            visible.map((item, index) => (
              <FeedRow
                key={item.key}
                item={item}
                isLast={index === visible.length - 1}
                myNames={[]}
              />
            ))
          )}
        </div>

        {unseen > 0 && (
          <button className="jump" onClick={jumpToLatest}>
            {unseen.toLocaleString()} new {unseen === 1 ? 'message' : 'messages'} <span aria-hidden="true">▾</span>
          </button>
        )}
      </div>

      <LlmSettings open={llmOpen} onClose={() => setLlmOpen(false)} />
      <BackendSettings
        open={backendOpen}
        config={backend}
        onClose={() => setBackendOpen(false)}
        onSaved={setBackend}
      />

      <StatsPanel stats={stats} />

      <AskPanel items={items} room={room} onAsk={ask} asking={asking} />
      <LogPanel entries={log.entries} tallies={log.tallies} onClear={log.clear} />
    </div>
  )
}