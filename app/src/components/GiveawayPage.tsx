import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import SpinWheel, { type Sector, type SpinWheelHandle } from 'ts-spin-wheel'
import { Confetti, type ConfettiRef } from './ui/confetti'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import type { StatsRecorder } from '../hooks/useStats'
import type { Chatter } from '../lib/stats'
import { useRoomEvents } from '../lib/reactive'
import type { SidecarEvent } from '../lib/sidecar'
import type { FeedItem } from '../types'

type GiveawayStatus = 'idle' | 'open' | 'review' | 'closed'
type GiveawayEntrant = { id: string; nickname: string; followed: boolean; eligible: boolean; keywordMessages: number; reason?: string }
type GiveawayDraw = { drawnAt: string; pool: string[]; winner: string }
const GIVEAWAY_WEB_ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5184'
const WHEEL_COLORS = ['#f59e0b', '#fb7185', '#38bdf8', '#a78bfa', '#34d399', '#f97316', '#e879f9', '#2dd4bf']

function formatTime(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function GiveawayPage({ stats, items, active = true, connected = false, streamer = '' }: { stats: StatsRecorder; items: FeedItem[]; active?: boolean; connected?: boolean; streamer?: string }) {
  const fallback = useMemo(() => {
    const unique = new Map<string, Chatter>()
    for (const item of items) {
      if (item.kind !== 'chat' || unique.has(item.id)) continue
      unique.set(item.id, {
        id: item.id,
        nickname: item.nickname,
        avatar: item.avatar,
        platform: item.platform,
        messages: item.repeatCount ?? 1,
        gifts: 0,
        diamonds: 0,
        follows: 0,
        shares: 0,
      })
    }
    return [...unique.values()]
  }, [items])
  // During hot reload an existing stats recorder can predate this getter. The
  // feed-derived fallback keeps the page usable until a fresh recorder is made.
  const getParticipants = useCallback(
    () => (typeof stats.getChatParticipants === 'function' ? stats.getChatParticipants() : fallback),
    [stats, fallback],
  )
  const participants = useSyncExternalStore(stats.subscribe, getParticipants, getParticipants)
  const participantsRef = useRef(participants)
  participantsRef.current = participants

  const [durationMinutes, setDurationMinutes] = useState(3)
  const [keyword, setKeyword] = useState('giveaway')
  const [prize, setPrize] = useState('')
  const [winnerCount, setWinnerCount] = useState(1)
  const [testMode, setTestMode] = useState(false)
  const [isTestRun, setIsTestRun] = useState(false)
  const [rulesCopied, setRulesCopied] = useState(false)
  const [snapshotUrl, setSnapshotUrl] = useState('')
  const [snapshotMessage, setSnapshotMessage] = useState('')
  const [publishingSnapshot, setPublishingSnapshot] = useState(false)
  const [announcedWinnerId, setAnnouncedWinnerId] = useState<string | null>(null)
  const [status, setStatus] = useState<GiveawayStatus>('idle')
  const [endsAt, setEndsAt] = useState<number | null>(null)
  const [reviewEndsAt, setReviewEndsAt] = useState<number | null>(null)
  const [remainingMs, setRemainingMs] = useState(0)
  const [entries, setEntries] = useState<Set<string>>(() => new Set())
  const [followed, setFollowed] = useState<Set<string>>(() => new Set())
  const [eligibleSnapshot, setEligibleSnapshot] = useState<string[]>([])
  const [entrySnapshot, setEntrySnapshot] = useState<GiveawayEntrant[]>([])
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [closedAt, setClosedAt] = useState<string | null>(null)
  const [winners, setWinners] = useState<string[]>([])
  const [drawHistory, setDrawHistory] = useState<GiveawayDraw[]>([])
  const [entryCounts, setEntryCounts] = useState<Record<string, number>>({})
  const [mockParticipants, setMockParticipants] = useState<Chatter[]>([])
  const [spinning, setSpinning] = useState(false)
  const spinWheelRef = useRef<SpinWheelHandle>(null)
  const confettiRef = useRef<ConfettiRef>(null)
  const enteredRef = useRef(new Set<string>())
  const entryCountsRef = useRef<Record<string, number>>({})
  const followedRef = useRef(new Set<string>())
  const entryKeyword = keyword.trim().toLowerCase()

  const eligibleIds = useMemo(() => {
    if (status === 'closed' || status === 'review') return eligibleSnapshot
    if (status !== 'open') return []
    return participants.filter((person) => entries.has(person.id) && followed.has(person.id)).map((person) => person.id)
  }, [status, eligibleSnapshot, participants, entries, followed])
  const availableIds = eligibleIds.filter((id) => !winners.includes(id))
  const wheelSectors: Sector[] = availableIds.map((_, index) => ({
    label: String(index + 1),
    color: WHEEL_COLORS[index % WHEEL_COLORS.length],
    text: '#fff',
  }))
  const repeatedMessages = Object.values(entryCounts).reduce((total, count) => total + Math.max(0, count - 1), 0)
  const canPublishSnapshot = drawHistory.length > 0 && (winners.length >= winnerCount || availableIds.length === 0)
  const settingsLocked = status !== 'idle' || spinning || Boolean(snapshotUrl)
  const displayParticipants = mockParticipants.length > 0 ? mockParticipants : participants
  const announcedWinner = announcedWinnerId ? displayParticipants.find((person) => person.id === announcedWinnerId) : undefined

  const closeGiveaway = useCallback(() => {
    if (status !== 'open') return
    const currentParticipants = typeof stats.getChatParticipants === 'function'
      ? stats.getChatParticipants()
      : participantsRef.current
    const snapshot = currentParticipants
      .filter((person) => enteredRef.current.has(person.id) && followedRef.current.has(person.id))
      .map((person) => person.id)
    const allEntrants = currentParticipants
      .filter((person) => enteredRef.current.has(person.id))
      .map((person) => ({
        id: person.id,
        nickname: person.nickname || `@${person.id}`,
        followed: followedRef.current.has(person.id),
        eligible: followedRef.current.has(person.id),
        keywordMessages: entryCountsRef.current[person.id] ?? 1,
        reason: followedRef.current.has(person.id) ? undefined : 'Follow not detected',
      }))
    setEntrySnapshot(allEntrants)
    setEligibleSnapshot(snapshot)
    setClosedAt(new Date().toISOString())
    setRemainingMs(0)
    setReviewEndsAt(Date.now() + 15_000)
    setRemainingMs(15_000)
    setStatus('review')
  }, [status, stats])

  const lockEntries = useCallback(() => {
    setReviewEndsAt(null)
    setRemainingMs(0)
    setStatus('closed')
  }, [])

  useEffect(() => {
    if (status !== 'open' || endsAt === null) return
    const tick = () => {
      const remaining = Math.max(0, endsAt - Date.now())
      setRemainingMs(remaining)
      if (remaining === 0) closeGiveaway()
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [status, endsAt, closeGiveaway])

  useEffect(() => {
    if (status !== 'review' || reviewEndsAt === null) return
    const tick = () => {
      const remaining = Math.max(0, reviewEndsAt - Date.now())
      setRemainingMs(remaining)
      if (remaining === 0) lockEntries()
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [status, reviewEndsAt, lockEntries])

  const onRoomEvent = useCallback((event: SidecarEvent & { platform: 'tiktok' }) => {
    if (status !== 'open' || endsAt === null) return
    if (Date.now() >= endsAt) {
      closeGiveaway()
      return
    }
    if (event.type === 'follow') {
      const next = new Set(followedRef.current)
      next.add(event.id)
      followedRef.current = next
      setFollowed(next)
      return
    }
    if (event.type === 'chat' && entryKeyword && event.text.toLowerCase().includes(entryKeyword)) {
      const counts = { ...entryCountsRef.current, [event.id]: (entryCountsRef.current[event.id] ?? 0) + 1 }
      entryCountsRef.current = counts
      setEntryCounts(counts)
      const next = new Set(enteredRef.current)
      next.add(event.id)
      enteredRef.current = next
      setEntries(next)
    }
  }, [status, endsAt, entryKeyword, closeGiveaway])
  useRoomEvents(onRoomEvent, [onRoomEvent])

  function startGiveaway() {
    if (!entryKeyword) return
    const now = Date.now()
    setIsTestRun(testMode)
    setEntryCounts({})
    entryCountsRef.current = {}
    setEntrySnapshot([])
    setEligibleSnapshot([])
    setWinners([])
    setDrawHistory([])
    setSnapshotUrl('')
    setSnapshotMessage('')
    setReviewEndsAt(null)
    if (testMode) {
      const fakeEntrants: GiveawayEntrant[] = Array.from({ length: 8 }, (_, index) => ({
        id: `test_viewer_${String(index + 1).padStart(2, '0')}`,
        nickname: `Test Viewer ${index + 1}`,
        followed: true,
        eligible: true,
        keywordMessages: index === 2 ? 3 : 1,
      }))
      const fakeIds = fakeEntrants.map((entrant) => entrant.id)
      const fakePeople: Chatter[] = fakeEntrants.map((entrant) => ({
        id: entrant.id,
        nickname: entrant.nickname,
        avatar: '',
        platform: 'tiktok',
        messages: entrant.keywordMessages,
        gifts: 0,
        diamonds: 0,
        follows: 1,
        shares: 0,
      }))
      const fakeCounts = Object.fromEntries(fakeEntrants.map((entrant) => [entrant.id, entrant.keywordMessages]))
      enteredRef.current = new Set(fakeIds)
      followedRef.current = new Set(fakeIds)
      entryCountsRef.current = fakeCounts
      setEntryCounts(fakeCounts)
      setEntries(new Set(fakeIds))
      setFollowed(new Set(fakeIds))
      setEntrySnapshot(fakeEntrants)
      setEligibleSnapshot(fakeIds)
      setMockParticipants(fakePeople)
      setStartedAt(new Date(now).toISOString())
      setClosedAt(new Date(now).toISOString())
      setEndsAt(null)
      setRemainingMs(0)
      setStatus('closed')
      return
    }
    setMockParticipants([])
    const alreadyFollowed = new Set(participants.filter((person) => person.follows > 0).map((person) => person.id))
    enteredRef.current = new Set()
    followedRef.current = alreadyFollowed
    setEntries(new Set())
    setFollowed(alreadyFollowed)
    setEligibleSnapshot([])
    setEntrySnapshot([])
    setStartedAt(new Date(now).toISOString())
    setClosedAt(null)
    setWinners([])
    setDrawHistory([])
    setEndsAt(now + durationMinutes * 60_000)
    setRemainingMs(durationMinutes * 60_000)
    setStatus('open')
  }

  function spinForWinner() {
    if (spinning || status !== 'closed' || winners.length >= winnerCount || availableIds.length === 0) return
    if (!spinWheelRef.current) return
    setSpinning(true)
    spinWheelRef.current.spin()
  }

  function finishWheelSpin(sector: Sector) {
    const winnerIndex = Number(sector.label) - 1
    const winner = availableIds[winnerIndex]
    if (!winner) {
      setSpinning(false)
      return
    }
    setDrawHistory((current) => [...current, { drawnAt: new Date().toISOString(), pool: [...availableIds], winner }])
    setWinners((current) => [...current, winner])
    setAnnouncedWinnerId(winner)
    setSpinning(false)
    void confettiRef.current?.fire({
      particleCount: 140,
      spread: 90,
      startVelocity: 44,
      origin: { y: 0.62 },
      colors: ['#f59e0b', '#fb7185', '#38bdf8', '#34d399', '#e879f9'],
    })
  }

  function resetGiveaway() {
    setSpinning(false)
    setStatus('idle')
    setEndsAt(null)
    setRemainingMs(0)
    setEntries(new Set())
    setFollowed(new Set())
    setEligibleSnapshot([])
    setEntrySnapshot([])
    setReviewEndsAt(null)
    setStartedAt(null)
    setClosedAt(null)
    setWinners([])
    setDrawHistory([])
    setEntryCounts({})
    setSnapshotUrl('')
    setSnapshotMessage('')
    entryCountsRef.current = {}
    setMockParticipants([])
    setIsTestRun(false)
    enteredRef.current = new Set()
    followedRef.current = new Set()
  }

  function buildAuditReport() {
    return {
      format: 'livechat-giveaway-audit-v1',
      streamer,
      keyword,
      durationMinutes,
      prize,
      winnerCount,
      testMode: isTestRun,
      startedAt,
      closedAt,
      entrants: entrySnapshot,
      eligibleCount: eligibleSnapshot.length,
      draws: drawHistory,
      randomness: 'ts-spin-wheel selection using Math.random',
      note: 'This report records the frozen entries and draw pools; it is not a cryptographic proof that the application itself was not modified.',
    }
  }

  function downloadAuditReport() {
    const report = buildAuditReport()
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `giveaway-audit-${closedAt ? closedAt.replace(/[:.]/g, '-') : 'report'}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function publishWebSnapshot() {
    if (status !== 'closed' || !canPublishSnapshot || publishingSnapshot) return
    if (snapshotUrl) {
      try {
        await navigator.clipboard.writeText(snapshotUrl)
        setSnapshotMessage('Public link copied.')
      } catch {
        setSnapshotMessage('Copy failed. Select the link below to copy it.')
      }
      return
    }

    setPublishingSnapshot(true)
    setSnapshotMessage('Publishing snapshot…')
    try {
      const response = await fetch(`${GIVEAWAY_WEB_ORIGIN}/api/giveaways/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: buildAuditReport() }),
      })
      const result = await response.json().catch(() => ({})) as { id?: string; detail?: string }
      if (!response.ok || !result.id) throw new Error(result.detail || `Publish failed (${response.status}).`)
      const url = `${GIVEAWAY_WEB_ORIGIN}/giveaway/${result.id}`
      setSnapshotUrl(url)
      try {
        await navigator.clipboard.writeText(url)
        setSnapshotMessage('Snapshot published and link copied.')
      } catch {
        setSnapshotMessage('Snapshot published. Select the link below to copy it.')
      }
    } catch (error) {
      setSnapshotMessage(error instanceof Error ? error.message : 'The snapshot could not be published.')
    } finally {
      setPublishingSnapshot(false)
    }
  }

  const rulesText = `Giveaway${prize.trim() ? ` — ${prize.trim()}` : ''}\nEntry keyword: ${keyword.trim()}\nRequirement: send a chat containing the keyword before entries close; follow status must be detected during the live session.\nEntry window: ${durationMinutes} minute(s)\nWinners: ${winnerCount}\nOne entry per account; repeated keyword messages do not increase odds.`

  async function copyRules() {
    try {
      await navigator.clipboard.writeText(rulesText)
      setRulesCopied(true)
      window.setTimeout(() => setRulesCopied(false), 2000)
    } catch {
      setRulesCopied(false)
    }
  }

  function removeEntrant(id: string) {
    setEntrySnapshot((current) => current.map((entrant) => entrant.id === id ? { ...entrant, eligible: false, reason: 'Removed during review' } : entrant))
    setEligibleSnapshot((current) => current.filter((entrantId) => entrantId !== id))
  }

  return (
    <main aria-hidden={!active} className={`page-view flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5 ${active ? '' : 'hidden'}`}>
      <header className="mx-auto w-full max-w-[760px]">
        <h1 className="m-0 text-xl font-semibold">Giveaway Picker</h1>
        <p className="mb-0 mt-1 text-xs text-app-muted">Collect entries, review the list, then draw the configured number of winners.</p>
      </header>

      <section className="mx-auto flex w-full max-w-[760px] flex-col gap-4 rounded-xl border border-app-line bg-app-panel p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs text-app-muted">
            <span>Entry keyword</span>
            <input className="input rounded-lg border border-app-line bg-app-bg px-3 py-2 text-app-text outline-none focus:border-app-accent disabled:opacity-60" value={keyword} onChange={(event) => setKeyword(event.target.value)} disabled={settingsLocked} maxLength={32} placeholder="e.g. giveaway" />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-app-muted">
            <span>Prize</span>
            <input className="input rounded-lg border border-app-line bg-app-bg px-3 py-2 text-app-text outline-none focus:border-app-accent disabled:opacity-60" value={prize} onChange={(event) => setPrize(event.target.value)} disabled={settingsLocked} maxLength={80} placeholder="e.g. VIP slot" />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-app-muted">
            <span>Countdown duration</span>
            <span className="flex items-center gap-2">
              <input className="input w-24 rounded-lg border border-app-line bg-app-bg px-3 py-2 text-app-text outline-none focus:border-app-accent disabled:opacity-60" type="number" min={1} max={30} step={1} value={durationMinutes} onChange={(event) => setDurationMinutes(Math.max(1, Math.min(30, Number(event.target.value) || 1)))} disabled={settingsLocked} />
              <span>minutes</span>
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-app-muted">
            <span>Number of winners</span>
            <input className="input w-24 rounded-lg border border-app-line bg-app-bg px-3 py-2 text-app-text outline-none focus:border-app-accent disabled:opacity-60" type="number" min={1} max={100} step={1} value={winnerCount} onChange={(event) => setWinnerCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} disabled={settingsLocked} />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-app-line bg-app-bg p-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-app-muted">Entry rules</div>
            <p className="mb-0 mt-1 break-words text-xs">{prize.trim() ? <><strong>{prize.trim()}</strong> · </> : null}Send a chat containing <strong>{keyword.trim() || '—'}</strong> within {durationMinutes} minute(s); follow status must be detected during this live session. One entry per account. {winnerCount} winner(s).</p>
          </div>
          <button className="btn shrink-0 rounded-lg border border-app-line px-3 py-2 text-xs" type="button" onClick={copyRules}>{rulesCopied ? 'Copied!' : 'Copy rules'}</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-app-muted">
          <input type="checkbox" checked={testMode} onChange={(event) => setTestMode(event.target.checked)} disabled={settingsLocked} />
          Test mode <span>(fictional participants; no real entry period)</span>
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-app-bg px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-app-muted">{status === 'open' ? 'Entry closes in' : status === 'review' ? 'Review locks in' : status === 'closed' ? 'Entries locked' : 'Ready to start'}</div>
            <CountdownRoll value={status === 'open' || status === 'review' ? formatTime(remainingMs) : status === 'closed' ? '00:00' : formatTime(durationMinutes * 60_000)} active={status === 'open' || status === 'review'} accent={status === 'open' || status === 'review'} />
          </div>
          <div className="flex flex-wrap gap-2">
            {status === 'idle' || status === 'closed' ? (
              <button className="btn btn-primary rounded-lg bg-app-accent px-4 py-2 font-semibold text-app-bg disabled:opacity-50" type="button" onClick={startGiveaway} disabled={(!connected && !testMode) || !entryKeyword || spinning}>{status === 'closed' ? 'Start new giveaway' : testMode ? 'Run test draw' : 'Start countdown'}</button>
            ) : status === 'open' ? (
              <button className="btn rounded-lg border border-app-line px-4 py-2 text-sm" type="button" onClick={closeGiveaway}>Close entries now</button>
            ) : (
              <button className="btn rounded-lg border border-app-line px-4 py-2 text-sm" type="button" onClick={lockEntries}>Lock entries now</button>
            )}
            {status === 'closed' && <button className="btn rounded-lg border border-app-line px-4 py-2 text-sm disabled:opacity-50" type="button" onClick={resetGiveaway} disabled={spinning}>Reset</button>}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-app-muted">
          <span>{entries.size} keyword entries</span>
          <span>{repeatedMessages} repeated messages ignored</span>
          <span>{followed.size} followed this session</span>
          <span className="font-semibold text-app-text">{eligibleIds.length} eligible</span>
        </div>
        {status === 'idle' && !connected && !testMode && <p className="m-0 text-xs text-app-muted">Connect to a live room before starting the countdown.</p>}
        {status === 'open' && <p className="m-0 text-xs text-app-muted">Include <strong className="text-app-text">{entryKeyword}</strong> in a chat message and follow the stream before time runs out to enter.</p>}
        {status === 'review' && <p className="m-0 text-xs text-app-muted">Entries are paused. Review the list below and remove invalid entries before the 15-second review period ends.</p>}
        {status === 'closed' && <div className="flex flex-col gap-3"><div className="flex flex-wrap items-center justify-between gap-3"><p className="m-0 text-xs text-app-muted">Entries are locked. Winners will not repeat. {isTestRun && <strong className="text-amber-400">TEST RUN — fictional participants</strong>}</p><div className="flex flex-wrap gap-2"><button className="btn rounded-lg border border-app-line px-3 py-2 text-xs" type="button" onClick={downloadAuditReport}>Download JSON</button><button className="btn rounded-lg border border-app-line px-3 py-2 text-xs disabled:opacity-50" type="button" onClick={publishWebSnapshot} disabled={publishingSnapshot || !canPublishSnapshot}>{publishingSnapshot ? 'Publishing…' : snapshotUrl ? 'Copy web link' : canPublishSnapshot ? (isTestRun ? 'Publish test snapshot to web' : 'Publish snapshot to web') : 'Finish winner draws to publish'}</button></div></div><p className="m-0 text-[11px] text-app-muted">{isTestRun ? 'Public test snapshot; participants are fictional.' : 'Web snapshot is public and includes participant handles.'}</p>{snapshotMessage && <p className="m-0 break-all text-xs text-app-muted" aria-live="polite">{snapshotMessage}</p>}{snapshotUrl && <a className="break-all text-xs text-app-accent underline" href={snapshotUrl} target="_blank" rel="noreferrer">{snapshotUrl}</a>}</div>}
      </section>

      <Confetti ref={confettiRef} manualstart className="[position:fixed] [inset:0] [z-index:60] [height:100vh] [width:100vw] [pointer-events:none]" />
      <Dialog open={Boolean(announcedWinnerId)} onOpenChange={(open) => { if (!open) setAnnouncedWinnerId(null) }}>
        <DialogContent className="border-app-line bg-app-panel text-app-text sm:max-w-sm" style={{ backgroundColor: 'var(--panel, #101010)', borderColor: 'var(--line, #303030)', color: 'var(--text, #f5f5f5)' }} aria-describedby="giveaway-winner-description">
          <DialogHeader className="items-center text-center">
            <DialogTitle className="text-app-accent">🎉 Winner{prize.trim() ? ` · ${prize.trim()}` : ''}</DialogTitle>
            <DialogDescription id="giveaway-winner-description" className="text-app-muted">The giveaway draw is complete.</DialogDescription>
          </DialogHeader>
          <div className="break-all text-center text-2xl font-bold">{announcedWinner?.nickname || `@${announcedWinnerId}`}</div>
          {announcedWinner?.nickname && <div className="-mt-3 text-center text-sm text-app-muted">@{announcedWinner.id}</div>}
          <DialogFooter className="sm:justify-center">
            <button className="btn btn-primary rounded-lg bg-app-accent px-5 py-2 font-semibold text-app-bg" type="button" onClick={() => setAnnouncedWinnerId(null)}>Close</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {status === 'closed' && winners.length === 0 && (
        <section className="mx-auto w-full max-w-[760px] rounded-xl border border-app-line bg-app-panel p-5 text-center">
          <p className="m-0 text-sm text-app-muted">No winner drawn yet.</p>
        </section>
      )}

      {status === 'closed' && eligibleIds.length > 0 && (
        <section className="mx-auto flex w-full max-w-[760px] flex-col items-center gap-4 rounded-xl border border-app-line bg-app-panel p-5">
          <h2 className="m-0 text-sm font-semibold">Spin wheel</h2>
          <div className="giveaway-wheel relative mt-2 flex flex-col items-center" aria-label={`Spin wheel with ${availableIds.length} available participants`}>
            <span className="relative z-10 mb-[-8px] h-0 w-0 border-x-[11px] border-t-[18px] border-x-transparent border-t-app-accent drop-shadow-md" aria-hidden="true" />
            <SpinWheel
              ref={spinWheelRef}
              sectors={wheelSectors}
              size={280}
              spinDuration={4200}
              enableSound={false}
              wheelBaseWidth={0}
              customModalContent={() => null}
              spinButtonStyles={{ display: 'none' }}
              onSpinEnd={finishWheelSpin}
            />
            <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] text-app-muted">
              {availableIds.slice(0, 12).map((id, index) => {
                const person = displayParticipants.find((candidate) => candidate.id === id)
                return <span key={id}>{index + 1}. {person?.nickname || `@${id}`}</span>
              })}
              {availableIds.length > 12 && <span>+{availableIds.length - 12} more</span>}
            </div>
          </div>
          <button className="btn btn-primary rounded-lg bg-app-accent px-5 py-2.5 font-semibold text-app-bg disabled:opacity-50" type="button" onClick={spinForWinner} disabled={spinning || availableIds.length === 0 || winners.length >= winnerCount}>
            {spinning ? 'Spinning…' : winners.length >= winnerCount ? 'All winners selected' : availableIds.length === 0 ? 'Everyone eligible has won' : winners.length > 0 ? `Spin for winner ${winners.length + 1} of ${winnerCount}` : `Spin for winner 1 of ${winnerCount}`}
          </button>
          {prize.trim() && <p className="m-0 text-xs text-app-muted">Prize: {prize.trim()}</p>}
        </section>
      )}

      {(status === 'review' || status === 'closed') && (
        <section className="mx-auto w-full max-w-[760px] rounded-xl border border-app-line bg-app-panel p-4">
          <h2 className="mb-2 mt-0 text-sm font-semibold">{status === 'review' ? 'Review entries' : 'Entry audit'}</h2>
          <p className="mb-3 mt-0 text-xs text-app-muted">Entries closed {closedAt ? new Date(closedAt).toLocaleString() : '—'} · {entrySnapshot.length} accounts · {eligibleSnapshot.length} eligible. Follow status is based on follow events received this session.</p>
          <div className="max-h-48 overflow-auto rounded-lg bg-app-bg p-2 text-xs">
            {entrySnapshot.length === 0 ? <p className="m-1 text-app-muted">No entries were recorded.</p> : entrySnapshot.map((entrant) => <div key={entrant.id} className="flex items-center justify-between gap-3 border-b border-app-line/50 py-1 last:border-0"><span className="min-w-0 truncate">{entrant.nickname} <span className="text-app-muted">@{entrant.id}</span>{entrant.keywordMessages > 1 && <span className="ml-2 text-amber-400">{entrant.keywordMessages} keyword messages · still 1 entry</span>}</span><span className="flex shrink-0 items-center gap-2"><span className={entrant.eligible ? 'text-emerald-400' : 'text-app-muted'}>{entrant.eligible ? 'Eligible' : entrant.reason ?? 'Not eligible'}</span>{status === 'review' && entrant.eligible && <button className="btn rounded border border-app-line px-2 py-1 text-[10px]" type="button" onClick={() => removeEntrant(entrant.id)}>Remove</button>}</span></div>)}
          </div>
          {drawHistory.length > 0 && <p className="mb-0 mt-3 text-xs text-app-muted">Draw log: {drawHistory.map((draw, index) => `#${index + 1} ${draw.winner} from ${draw.pool.length} participants`).join(' · ')}</p>}
        </section>
      )}

      {status === 'closed' && eligibleIds.length > 0 && (
        <section className="mx-auto w-full max-w-[760px] rounded-xl border border-app-line bg-app-panel p-4">
          <h2 className="mb-3 mt-0 text-sm font-semibold">Eligible participants ({eligibleIds.length})</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {eligibleIds.slice(0, 100).map((id, index) => {
              const person = displayParticipants.find((candidate) => candidate.id === id)
              return <div key={id} className="flex min-w-0 items-center gap-2 rounded-lg bg-app-bg px-3 py-2 text-xs"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-app-panel font-mono font-bold text-app-accent">{index + 1}</span><span className="min-w-0 flex-1 truncate">{person?.nickname || `@${id}`}</span><span className="shrink-0 text-app-muted">@{id}</span>{winners.includes(id) && <span className="shrink-0 font-semibold text-app-accent">Winner</span>}</div>
            })}
          </div>
          {eligibleIds.length > 100 && <p className="mb-0 mt-3 text-xs text-app-muted">Showing the first 100; everyone in the count is eligible for the draw.</p>}
        </section>
      )}
    </main>
  )
}

function CountdownRoll({ value, active, accent }: { value: string; active: boolean; accent: boolean }) {
  return (
    <div className={`mt-1 flex font-mono text-2xl font-bold tabular-nums ${accent ? 'text-app-accent' : 'text-app-text'}`} aria-label={value}>
      {value.split('').map((character, index) => character === ':'
        ? <span key={`separator-${index}`} className="mx-0.5">:</span>
        : <span key={`digit-${index}`} className="h-[1.2em] w-[0.68em] overflow-hidden text-center leading-[1.2em]">
            <span className="flex flex-col" style={{ transform: `translateY(-${Number(character) * 1.2}em)`, transition: active ? 'transform 420ms cubic-bezier(0.2, 0.75, 0.25, 1)' : 'none' }}>
              {Array.from({ length: 10 }, (_, digit) => <span key={digit} className="h-[1.2em] shrink-0 leading-[1.2em]">{digit}</span>)}
            </span>
          </span>)}
    </div>
  )
}

