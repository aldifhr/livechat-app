'use client'

/**
 * The giveaway picker, on the dashboard.
 *
 * A port of `desktop/src/components/GiveawayPage.tsx`. Same state machine, same
 * commit-reveal draw, same audit report — but the entries come off the backend's
 * room socket (`/ws/overlay/<room>`) instead of the desktop host, and it saves a
 * snapshot to this app instead of publishing through the desktop's sidecar.
 *
 * The draw math lives in `lib/giveaway.ts`, duplicated from the app on purpose: the
 * whole value of the audit report is that the app and the web derive a winner the
 * same way.
 */

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/client/api'
import { profilePath } from '@/lib/client/streamLinks'
import {
  sha256,
  deriveWinnerFromSeed,
  type GiveawayDraw,
  type GiveawayEntrant,
  type GiveawayReport,
} from '@/lib/giveaway'
import { useRoomEvents } from '@/hooks/useRoomEvents'
import type { Room } from '@/lib/types'
import type { OverlayEventFrame } from '@shared/events'
import Confetti, { type ConfettiRef } from '@/components/Confetti'
import SpinWheel, { type SpinWheelHandle, type WheelSector } from '@/components/SpinWheel'

type GiveawayStatus = 'idle' | 'open' | 'review' | 'closed'
type Person = { id: string; nickname: string; avatar: string }

const WHEEL_COLORS = ['#f59e0b', '#fb7185', '#38bdf8', '#a78bfa', '#34d399', '#f97316', '#e879f9', '#2dd4bf']
const REVIEW_MS = 15_000

function formatTime(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export default function GiveawayRunner({ handle, backendOrigin }: { handle: string; backendOrigin: string }) {
  const wanted = decodeURIComponent(handle).trim().replace(/^@/, '')

  const [rooms, setRooms] = useState<Room[]>([])
  const [loadedRooms, setLoadedRooms] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.rooms()
      .then(({ rooms: found }) => {
        if (!cancelled) setRooms(found)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadedRooms(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const room = rooms.find((candidate) => candidate.username === wanted || candidate.id === wanted)
  const roomId = room?.id ?? ''
  const streamer = room?.username || wanted

  const [durationMinutes, setDurationMinutes] = useState(3)
  const [keyword, setKeyword] = useState('giveaway')
  const [prize, setPrize] = useState('')
  const [winnerCount, setWinnerCount] = useState(1)
  const [testMode, setTestMode] = useState(false)
  const [isTestRun, setIsTestRun] = useState(false)
  const [rulesCopied, setRulesCopied] = useState(false)
  const [snapshotUrl, setSnapshotUrl] = useState('')
  const [snapshotMessage, setSnapshotMessage] = useState('')
  const [downloadMessage, setDownloadMessage] = useState('')
  const [publishingSnapshot, setPublishingSnapshot] = useState(false)
  const [connected, setConnected] = useState(false)

  const [people, setPeople] = useState<Map<string, Person>>(() => new Map())
  const peopleRef = useRef(people)
  peopleRef.current = people

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
  const [mockParticipants, setMockParticipants] = useState<Person[]>([])
  const [spinning, setSpinning] = useState(false)
  const [commitHash, setCommitHash] = useState('')
  const [commitId, setCommitId] = useState('')
  const [committedAt, setCommittedAt] = useState('')
  const [commitError, setCommitError] = useState('')
  const [revealSeed, setRevealSeed] = useState('')
  const [entrantHash, setEntrantHash] = useState('')
  const [showSeed, setShowSeed] = useState(false)
  const [announcedWinnerId, setAnnouncedWinnerId] = useState<string | null>(null)

  const wheelRef = useRef<SpinWheelHandle>(null)
  const confettiRef = useRef<ConfettiRef>(null)
  const pendingWinnerRef = useRef<string | null>(null)
  const seedRef = useRef('')
  const enteredRef = useRef(new Set<string>())
  const entryCountsRef = useRef<Record<string, number>>({})
  const followedRef = useRef(new Set<string>())
  const eligibleRef = useRef<string[]>([])
  eligibleRef.current = eligibleSnapshot
  const entryKeyword = keyword.trim().toLowerCase()

  const recordPerson = useCallback((id: string, nickname: string, avatar: string) => {
    setPeople((prev) => {
      if (prev.has(id)) return prev
      const next = new Map(prev)
      next.set(id, { id, nickname, avatar })
      return next
    })
  }, [])

  const closeGiveaway = useCallback(async () => {
    if (status !== 'open') return
    const current = [...peopleRef.current.values()]
    const snapshot = current.filter((p) => enteredRef.current.has(p.id) && followedRef.current.has(p.id)).map((p) => p.id)
    const allEntrants: GiveawayEntrant[] = current
      .filter((p) => enteredRef.current.has(p.id))
      .map((p) => {
        const eligible = followedRef.current.has(p.id)
        return {
          id: p.id,
          nickname: p.nickname || `@${p.id}`,
          followed: eligible,
          eligible,
          keywordMessages: entryCountsRef.current[p.id] ?? 1,
          reason: eligible ? undefined : 'Follow not detected',
        }
      })
    setEntrySnapshot(allEntrants)
    setEligibleSnapshot(snapshot)
    setClosedAt(new Date().toISOString())
    setRemainingMs(REVIEW_MS)
    setReviewEndsAt(Date.now() + REVIEW_MS)
    setStatus('review')
  }, [status])

  /**
   * Fix a seed for the frozen pool, on the server.
   *
   * Called once the entries are final — after the review removals, so the hash it
   * seals is the list actually drawn from. The server holds the seed and returns
   * only its hash; the seed is fetched at the first draw. This is the step that
   * makes the report checkable rather than a story.
   */
  const anchorCommit = useCallback(async (poolIds: string[]) => {
    const poolHash = await sha256([...poolIds].sort().join('|'))
    setEntrantHash(poolHash)
    try {
      const response = await fetch('/api/giveaways/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poolHash }),
      })
      const result = (await response.json().catch(() => ({}))) as { id?: string; commitHash?: string; committedAt?: string; detail?: string }
      if (!response.ok || !result.id || !result.commitHash) throw new Error(result.detail || 'commit failed')
      seedRef.current = ''
      setCommitId(result.id)
      setCommitHash(result.commitHash)
      setCommittedAt(result.committedAt ?? '')
      setCommitError('')
    } catch {
      setCommitError('Could not commit the draw to the server, so it cannot be published as verifiable. Try again.')
    }
  }, [])

  const lockEntries = useCallback(() => {
    setReviewEndsAt(null)
    setRemainingMs(0)
    setStatus('closed')
    void anchorCommit(eligibleRef.current)
  }, [anchorCommit])

  useEffect(() => {
    if (status !== 'open' || endsAt === null) return
    const tick = () => {
      const remaining = Math.max(0, endsAt - Date.now())
      setRemainingMs(remaining)
      if (remaining === 0) void closeGiveaway()
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

  const onRoomEvent = useCallback((frame: OverlayEventFrame) => {
    if (frame.type === 'status') {
      setConnected(Boolean(frame.connected))
      return
    }
    if (frame.type !== 'comment' && frame.type !== 'follow') return
    const id = frame.userId || frame.user
    if (!id) return
    recordPerson(id, frame.user, frame.avatar ?? '')

    if (frame.type === 'follow') {
      if (!followedRef.current.has(id)) {
        const next = new Set(followedRef.current)
        next.add(id)
        followedRef.current = next
        setFollowed(next)
      }
      return
    }

    if (status !== 'open' || endsAt === null) return
    if (Date.now() >= endsAt) {
      void closeGiveaway()
      return
    }
    if (entryKeyword && frame.text.toLowerCase().includes(entryKeyword)) {
      const counts = { ...entryCountsRef.current, [id]: (entryCountsRef.current[id] ?? 0) + 1 }
      entryCountsRef.current = counts
      setEntryCounts(counts)
      const next = new Set(enteredRef.current)
      next.add(id)
      enteredRef.current = next
      setEntries(next)
    }
  }, [status, endsAt, entryKeyword, closeGiveaway, recordPerson])

  useRoomEvents(backendOrigin, roomId, onRoomEvent)

  const displayParticipants = mockParticipants.length > 0 ? mockParticipants : [...people.values()]

  const eligibleIds = useMemo(() => {
    if (status === 'closed' || status === 'review') return eligibleSnapshot
    if (status !== 'open') return []
    return [...people.values()].filter((p) => entries.has(p.id) && followed.has(p.id)).map((p) => p.id)
  }, [status, eligibleSnapshot, people, entries, followed])
  const availableIds = eligibleIds.filter((id) => !winners.includes(id))

  const wheelSectors: WheelSector[] = availableIds.map((id, index) => ({
    label: displayParticipants.find((p) => p.id === id)?.nickname || `@${id}`,
    color: WHEEL_COLORS[index % WHEEL_COLORS.length],
    text: '#fff',
  }))

  const canPublishSnapshot = drawHistory.length > 0 && (winners.length >= winnerCount || availableIds.length === 0)
  const settingsLocked = status !== 'idle' || spinning || Boolean(snapshotUrl)
  const announcedWinner = announcedWinnerId ? displayParticipants.find((p) => p.id === announcedWinnerId) : undefined
  const repeatedMessages = Object.values(entryCounts).reduce((total, count) => total + Math.max(0, count - 1), 0)

  async function startGiveaway() {
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
    seedRef.current = ''
    setCommitId('')
    setCommittedAt('')
    setCommitHash('')
    setEntrantHash('')
    setRevealSeed('')
    setCommitError('')
    if (testMode) {
      const fakeEntrants: GiveawayEntrant[] = Array.from({ length: 8 }, (_, index) => ({
        id: `test_viewer_${String(index + 1).padStart(2, '0')}`,
        nickname: `Test Viewer ${index + 1}`,
        followed: true,
        eligible: true,
        keywordMessages: index === 2 ? 3 : 1,
      }))
      const fakeIds = fakeEntrants.map((entrant) => entrant.id)
      const fakePeople: Person[] = fakeEntrants.map((entrant) => ({ id: entrant.id, nickname: entrant.nickname, avatar: '' }))
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
      void anchorCommit(fakeIds)
      return
    }
    setMockParticipants([])
    // Kept, not cleared: followers seen since the page opened count, and the entry
    // window only decides who enters, not who counts as following.
    enteredRef.current = new Set()
    entryCountsRef.current = {}
    setEntries(new Set())
    setEntrySnapshot([])
    setEligibleSnapshot([])
    setWinners([])
    setDrawHistory([])
    setStartedAt(new Date(now).toISOString())
    setClosedAt(null)
    setEndsAt(now + durationMinutes * 60_000)
    setRemainingMs(durationMinutes * 60_000)
    setStatus('open')
  }

  async function spinForWinner() {
    if (spinning || status !== 'closed' || winners.length >= winnerCount || availableIds.length === 0) return
    if (!wheelRef.current) return
    if (!seedRef.current) {
      if (!commitId) return
      try {
        const response = await fetch(`/api/giveaways/commit/${commitId}`, { method: 'POST' })
        const result = (await response.json().catch(() => ({}))) as { seed?: string; detail?: string }
        if (!response.ok || !result.seed) throw new Error(result.detail || 'reveal failed')
        seedRef.current = result.seed
      } catch {
        setCommitError('Could not reveal the committed seed, so no winner can be drawn.')
        return
      }
    }
    const pool = [...availableIds]
    const winner = await deriveWinnerFromSeed(seedRef.current, pool)
    if (!winner) return
    setSpinning(true)
    wheelRef.current.spin(Math.max(0, pool.indexOf(winner)))
    setRevealSeed('')
    pendingWinnerRef.current = winner
  }

  function finishWheelSpin() {
    const winner = pendingWinnerRef.current
    if (!winner) return
    pendingWinnerRef.current = null
    setDrawHistory((current) => [...current, { drawnAt: new Date().toISOString(), pool: availableIds, winner }])
    setWinners((current) => [...current, winner])
    setAnnouncedWinnerId(winner)
    setSpinning(false)
    setRevealSeed(seedRef.current)
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
    setReviewEndsAt(null)
    setStartedAt(null)
    setClosedAt(null)
    setWinners([])
    setDrawHistory([])
    setEntryCounts({})
    setSnapshotUrl('')
    setSnapshotMessage('')
    setCommitHash('')
    setCommitId('')
    setCommittedAt('')
    setRevealSeed('')
    setEntrantHash('')
    setCommitError('')
    setShowSeed(false)
    setMockParticipants([])
    setIsTestRun(false)
    seedRef.current = ''
  }

  function buildAuditReport(): GiveawayReport {
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
      randomness: 'winner derived from SHA-256(seed + sorted_pool); wheel spin is visual only',
      commitHash,
      poolHash: entrantHash,
      revealSeed,
      commitId: commitId || undefined,
      committedAt: committedAt || undefined,
      note: 'This report records the frozen entries and draw pools; it is not a cryptographic proof that the application itself was not modified.',
    }
  }

  function downloadAuditReport() {
    let url = ''
    const fileName = `giveaway-audit-${closedAt ? closedAt.replace(/[:.]/g, '-') : 'report'}.json`
    try {
      url = URL.createObjectURL(new Blob([JSON.stringify(buildAuditReport(), null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.style.display = 'none'
      document.body.append(link)
      link.click()
      link.remove()
      setDownloadMessage(`Download started: ${fileName}.`)
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      if (url) URL.revokeObjectURL(url)
      setDownloadMessage('Download failed. Please try again.')
    }
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
      const response = await fetch('/api/giveaways/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: buildAuditReport() }),
      })
      const result = (await response.json().catch(() => ({}))) as { id?: string; detail?: string }
      if (!response.ok || !result.id) throw new Error(result.detail || `Publish failed (${response.status}).`)
      const url = `${window.location.origin}/giveaway/${result.id}`
      setSnapshotUrl(url)
      try {
        await navigator.clipboard.writeText(url)
        setSnapshotMessage('Snapshot published and link copied.')
      } catch {
        setSnapshotMessage('Snapshot published. Select the link below to copy it.')
      }
    } catch (cause) {
      setSnapshotMessage(cause instanceof Error ? cause.message : 'The snapshot could not be published.')
    } finally {
      setPublishingSnapshot(false)
    }
  }

  function removeEntrant(id: string) {
    setEntrySnapshot((current) => current.map((entrant) => (entrant.id === id ? { ...entrant, eligible: false, reason: 'Removed during review' } : entrant)))
    setEligibleSnapshot((current) => current.filter((entrantId) => entrantId !== id))
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

  if (!loadedRooms) return <div className="empty">Loading this stream…</div>
  if (!room) {
    return (
      <>
        <div className="page-head">
          <div>
            <h2>No such stream</h2>
            <p className="muted">
              Nothing here is called <strong>@{wanted}</strong>.
            </p>
          </div>
        </div>
        <div className="panel">
          <Link className="btn" href="/admin/streams">
            Back to streams
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <Confetti ref={confettiRef} manualstart className="pointer-events-none fixed inset-0 z-60 h-screen w-screen" />

      <div className="page-head">
        <div>
          <p className="faint">
            <Link className="quiet-link" href={profilePath(room.username, room.id)}>
              ← {room.username ? `@${room.username}` : room.name}
            </Link>
          </p>
          <h2>Giveaway picker</h2>
          <p className="muted">
            Collect entries, review the list, then draw the configured number of winners. {connected ? 'Listening to the room.' : 'Not connected — start the stream, or use test mode.'}
          </p>
        </div>
      </div>

      <div className="panel">
        <h3>Setup</h3>
        <div className="field-row">
          <div className="field">
            <label htmlFor="gw-keyword">Entry keyword</label>
            <input id="gw-keyword" value={keyword} maxLength={32} disabled={settingsLocked} placeholder="e.g. giveaway" onChange={(e) => setKeyword(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="gw-prize">Prize</label>
            <input id="gw-prize" value={prize} maxLength={80} disabled={settingsLocked} placeholder="e.g. VIP slot" onChange={(e) => setPrize(e.target.value)} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="gw-duration">Countdown (minutes)</label>
            <input id="gw-duration" type="number" min={1} max={30} value={durationMinutes} disabled={settingsLocked} onChange={(e) => setDurationMinutes(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
          </div>
          <div className="field">
            <label htmlFor="gw-winners">Number of winners</label>
            <input id="gw-winners" type="number" min={1} max={100} value={winnerCount} disabled={settingsLocked} onChange={(e) => setWinnerCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="gw-test">Test mode</label>
          <select id="gw-test" value={testMode ? 'on' : 'off'} disabled={settingsLocked} onChange={(e) => setTestMode(e.target.value === 'on')}>
            <option value="off">Off — real participants</option>
            <option value="on">On — fictional participants</option>
          </select>
        </div>
        <p className="faint tight-caption">{rulesText.split('\n').join(' ')}</p>
        <button type="button" onClick={() => void copyRules()}>{rulesCopied ? 'Copied!' : 'Copy rules'}</button>
      </div>

      <div className="panel">
        <div className="row">
          <div className="grow">
            <span className="stat-label">
              {status === 'open' ? 'Entry closes in' : status === 'review' ? 'Review locks in' : status === 'closed' ? 'Entries locked' : 'Ready to start'}
            </span>
            <CountdownRoll value={status === 'open' || status === 'review' ? formatTime(remainingMs) : status === 'closed' ? '00:00' : formatTime(durationMinutes * 60_000)} active={status === 'open' || status === 'review'} />
          </div>
          {(status === 'open' || status === 'review') && (
            <div>
              <span className="stat-label">Live participants</span>
              <div className="stat-value">{eligibleIds.length}</div>
            </div>
          )}
          <div className="actions">
            {status === 'idle' || status === 'closed' ? (
              <button className="primary" type="button" onClick={() => void startGiveaway()} disabled={(!connected && !testMode) || !entryKeyword || spinning}>
                {status === 'closed' ? 'Start new giveaway' : testMode ? 'Run test draw' : 'Start countdown'}
              </button>
            ) : status === 'open' ? (
              <button type="button" onClick={() => void closeGiveaway()}>Close entries now</button>
            ) : (
              <button type="button" onClick={lockEntries}>Lock entries now</button>
            )}
            {status === 'closed' && <button type="button" onClick={resetGiveaway} disabled={spinning}>Reset</button>}
          </div>
        </div>
        <p className="faint tight-caption">
          {entries.size} keyword entries · {repeatedMessages} repeated messages ignored · {followed.size} followed · {eligibleIds.length} eligible
        </p>
        {commitError && <div className="notice error tight-caption">{commitError}</div>}
        {commitHash && (
          <p className="faint mono tight-caption">
            Commit: {commitHash.slice(0, 16)}…{entrantHash && ` · Pool hash: ${entrantHash.slice(0, 16)}…`}
            {committedAt && ` · committed ${new Date(committedAt).toLocaleString()}`}
          </p>
        )}
        {status === 'open' && <p className="tight-caption"><strong>{entryKeyword}</strong> in a chat, and follow the stream, before time runs out.</p>}
        {status === 'review' && <p className="tight-caption">Entries paused. Review below; the 15-second review ends on its own.</p>}
      </div>

      {announcedWinnerId && (
        <div className="fixed inset-0 z-60 grid place-items-center p-4" style={{ background: 'rgb(0 0 0 / 0.6)' }} role="dialog" aria-modal="true" aria-label="Winner">
          <div className="panel max-w-sm text-center">
            <h3 className="flush-top">🎉 Winner{prize.trim() ? ` · ${prize.trim()}` : ''}</h3>
            <p className="muted">The giveaway draw is complete.</p>
            <p className="stat-value break-all">{announcedWinner?.nickname || `@${announcedWinnerId}`}</p>
            {announcedWinner?.nickname && <p className="faint">@{announcedWinner.id}</p>}
            <button className="primary stack-top" type="button" onClick={() => setAnnouncedWinnerId(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {status === 'closed' && (
        <div className="panel">
          <h3>Result</h3>
          {winners.length === 0 ? (
            <p className="muted flush">No winner drawn yet.</p>
          ) : (
            <p className="flush">
              Winners: {winners.map((id) => displayParticipants.find((p) => p.id === id)?.nickname || `@${id}`).join(', ')}
            </p>
          )}
          <div className="stack-top flex flex-wrap gap-2">
            <button type="button" onClick={downloadAuditReport}>Download JSON</button>
            <button className="primary" type="button" onClick={() => void publishWebSnapshot()} disabled={publishingSnapshot || !canPublishSnapshot}>
              {publishingSnapshot ? 'Publishing…' : snapshotUrl ? 'Copy web link' : isTestRun ? 'Publish test snapshot' : 'Publish snapshot'}
            </button>
          </div>
          {downloadMessage && <p className="faint tight-caption" role="status">{downloadMessage}</p>}
          {snapshotMessage && <p className="faint tight-caption" role="status">{snapshotMessage}</p>}
          {snapshotUrl && (
            <a className="quiet-link break-all" href={snapshotUrl} target="_blank" rel="noreferrer">
              {snapshotUrl}
            </a>
          )}
        </div>
      )}

      {status === 'closed' && eligibleIds.length > 0 && (
        <div className="panel">
          <h3>Spin wheel</h3>
          <div className="preview-canvas-row">
            <SpinWheel ref={wheelRef} sectors={wheelSectors} onSpinEnd={finishWheelSpin} />
          </div>
          <div className="stack-top text-center">
            <button className="primary" type="button" onClick={() => void spinForWinner()} disabled={spinning || availableIds.length === 0 || winners.length >= winnerCount}>
              {spinning ? 'Spinning…' : winners.length >= winnerCount ? 'All winners selected' : availableIds.length === 0 ? 'Everyone eligible has won' : `Spin for winner ${winners.length + 1} of ${winnerCount}`}
            </button>
          </div>
          {revealSeed && (
            <p className="tight-caption text-center">
              <button type="button" onClick={() => setShowSeed((v) => !v)}>{showSeed ? 'Hide seed' : 'Reveal seed'}</button>
            </p>
          )}
          {showSeed && revealSeed && (
            <p className="faint mono break-all tight-caption">
              Seed: {revealSeed} · sha256(seed) = {commitHash}
            </p>
          )}
        </div>
      )}

      {(status === 'review' || status === 'closed') && (
        <div className="panel">
          <h3>{status === 'review' ? 'Review entries' : 'Entry audit'}</h3>
          <p className="faint tight-caption">
            {entrySnapshot.length} accounts · {eligibleSnapshot.length} eligible. Follow status is based on follow events received this session.
          </p>
          {entrySnapshot.length === 0 ? (
            <p className="muted flush">No entries were recorded.</p>
          ) : (
            <ul className="log-entries">
              {entrySnapshot.map((entrant) => (
                <li className="row" key={entrant.id}>
                  <span className="grow">
                    {entrant.nickname} <span className="faint mono">@{entrant.id}</span>
                    {entrant.keywordMessages > 1 && <span className="faint"> · {entrant.keywordMessages} messages, 1 entry</span>}
                  </span>
                  <span className="badge">{entrant.eligible ? 'eligible' : entrant.reason ?? 'not eligible'}</span>
                  {status === 'review' && entrant.eligible && (
                    <button type="button" onClick={() => removeEntrant(entrant.id)}>Remove</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {drawHistory.length > 0 && (
            <p className="faint tight-caption">
              Draw log: {drawHistory.map((draw, index) => `#${index + 1} ${draw.winner} from ${draw.pool.length}`).join(' · ')}
            </p>
          )}
        </div>
      )}
    </>
  )
}

function CountdownRoll({ value, active }: { value: string; active: boolean }) {
  return (
    <div className={`flex font-mono text-2xl font-bold tabular-nums ${active ? 'text-accent' : ''}`} aria-label={value}>
      {value.split('').map((character, index) =>
        character === ':' ? (
          <span key={`sep-${index}`} className="mx-0.5">
            :
          </span>
        ) : (
          <span key={`digit-${index}`} className="h-[1.2em] w-[0.68em] overflow-hidden text-center leading-[1.2em]">
            <span
              className="flex flex-col"
              style={{ transform: `translateY(-${Number(character) * 1.2}em)`, transition: active ? 'transform 420ms cubic-bezier(0.2,0.75,0.25,1)' : 'none' }}
            >
              {Array.from({ length: 10 }, (_, digit) => (
                <span key={digit} className="h-[1.2em] shrink-0 leading-[1.2em]">
                  {digit}
                </span>
              ))}
            </span>
          </span>
        ),
      )}
    </div>
  )
}
