import { useCallback, useEffect, useRef, useState } from 'react'
import { FeedRow } from './components/FeedRow'
import { LogPanel } from './components/LogPanel'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { StatsPanel } from './components/StatsPanel'
import { Toolbar } from './components/Toolbar'

import { useAutoReply } from './hooks/useAutoReply'
import { useChat } from './hooks/useChat'
import { useChatAlerts } from './hooks/useChatAlerts'
import { useGiftNotification } from './hooks/useGiftNotification'
import { useGiftSound } from './hooks/useGiftSound'
import { useJoinSound } from './hooks/useJoinSound'
import { useMentionAlert } from './hooks/useMentionAlert'

import { useSettings } from './hooks/useSettings'
import { useKindCounts, useVisibleItems, type FeedFilters } from './hooks/useVisibleItems'
import { EMPTY_BACKEND, type BackendConfig } from './lib/backend'
import { myHandles } from './lib/mentions'
import { host } from './lib/sidecar'

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backend, setBackend] = useState<BackendConfig>(EMPTY_BACKEND)
  const [filters, setFilters] = useState<FeedFilters>({ kind: 'all', search: '' })
  const settings = useSettings()
  const { nudgeFontScale } = settings

  useGiftSound({
    enabled: settings.giftSound,
    templateId: settings.giftTemplate,
    customPath: settings.customSoundPath,
  })
  useJoinSound({
    enabled: settings.joinSound,
    templateId: settings.joinTemplate,
    customPath: settings.customSoundPath,
  })
  useGiftNotification({
    notice: settings.giftNotice,
    voice: settings.giftVoice,
    ttsPace: settings.ttsPace,
  })
  useAutoReply({ enabled: settings.autoReply })
  useMentionAlert({
    myHandle: settings.myHandle,
    sound: settings.mentionAlert,
    voice: settings.mentionVoice,
    ttsPace: settings.ttsPace,
  })

  // The handles that count as "me", parsed once here rather than per row: the feed
  // is the busiest path in the app and every chat row is checked against them.
  const mine = myHandles(settings.myHandle)
  useChatAlerts({
    chatSound: settings.chatSound,
    chatTts: settings.chatTts,
    ttsPace: settings.ttsPace,
    templateId: settings.chatTemplate,
    customPath: settings.customSoundPath,
  })

  const { room, items, totalReceived, clear, log, health, stats } = useChat({
    collapseWindowMs: 2500,
    // Only worth collapsing when a spam wave is actually running; two identical
    // messages in a row are usually just someone repeating themselves.
    collapseThreshold: settings.collapse ? 2 : 0,
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

  return (
    <div className="app">
      <Toolbar
        room={room}
        counts={counts}
        totalReceived={totalReceived}
        kind={filters.kind}
        search={filters.search}
        health={health}
        settings={settings}
        backend={backend}
        items={items.length}
        onFiltersChange={onFiltersChange}
        onClearChat={clear}
        onOpenSettings={() => setSettingsOpen(true)}
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
            visible.map((item, index) => (
              <FeedRow
                key={item.key}
                item={item}
                isLast={index === visible.length - 1}
                myNames={mine}
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

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
      />

      {settings.showStats && <StatsPanel stats={stats} />}

      {settings.showLog && <LogPanel entries={log.entries} tallies={log.tallies} onClear={log.clear} />}
    </div>
  )
}