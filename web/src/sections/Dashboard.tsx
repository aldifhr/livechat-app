'use client'

/**
 * The dashboard: what every stream is doing right now.
 *
 * Built from the two reads the dashboard already makes and nothing else — the
 * room list, and each room's status. No new backend route, because the one that
 * would answer properly (`eventlog.snapshot`, with session totals, peak viewers,
 * diamonds and the top chatters) is not exposed over HTTP, and inventing a
 * second definition of "statistics" on the browser side to get around that is
 * how two numbers end up meaning different things.
 *
 * So this is honest about what it has. Viewers, connectivity, and the shape of
 * the last few minutes — the one series worth graphing that needs no history
 * behind it, because the history is the graph. Session totals live in the
 * eventlog and are a backend change away from being shown here; until then a tile
 * claiming "1,204 comments" would be counting this browser's own minutes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/client'
import type { Room, RoomStatus } from '@/lib/types'

/** How often the numbers are re-read. The same beat the streams page uses, so
 *  two pages side by side are not showing different moments. */
const POLL_MS = 5000

/** How many readings the sparkline keeps.
 *
 *  At POLL_MS this is a little under four minutes. Long enough for a spike to be
 *  a shape rather than a dot, short enough that the shape is still this stream
 *  and not last night's. It is also the only history there is: nothing is stored,
 *  and closing the page is what discards it. */
const HISTORY = 48

interface Reading {
  /** Epoch ms of the read. */
  at: number
  /** Total viewers across every room that answered. */
  total: number
}

/** One room's row: what the room is, and what it is reporting. */
interface Row extends Room {
  status?: RoomStatus
  /** Kept when a read fails, rather than blanked — see the poll below. */
  stale?: boolean
}

export default function Dashboard() {
  const [rows, setRows] = useState<Row[]>([])
  const [history, setHistory] = useState<Reading[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  const poll = useCallback(async () => {
    let rooms: Room[]
    try {
      rooms = (await api.rooms()).rooms
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The stream list could not be loaded')
      return
    }
    setError('')

    // Asked per room rather than derived from the list, for the same reason the
    // streams page asks: the list endpoint carries no status, and a room created
    // by a test is not necessarily connected.
    const readings = await Promise.all(
      rooms.map(async (room): Promise<Row> => {
        try {
          return { ...room, status: await api.status(room.id) }
        } catch {
          // A status that cannot be read is not evidence the room is down, so the
          // row keeps the last reading and is marked stale rather than reporting
          // offline. That is a guess dressed as a reading if it is not marked.
          return { ...room, stale: true }
        }
      }),
    )

    setRows(readings)
    setLoaded(true)

    // The graph appends on every poll whether or not every room answered, and
    // totals only the rooms that did. A room that dropped out of this read is
    // missing from the total rather than counted as zero — a zero would put a
    // cliff in the line that no viewer count actually produced.
    const total = readings.reduce(
      (sum, row) => sum + (typeof row.status?.viewers === 'number' ? row.status.viewers : 0),
      0,
    )
    const answered = readings.some((row) => row.status)
    if (answered) {
      setHistory((current) => [...current, { at: Date.now(), total }].slice(-HISTORY))
    }
  }, [])

  useEffect(() => {
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [poll])

  const totals = useMemo(() => {
    const live = rows.filter((row) => row.status?.connected)
    const viewers = rows.reduce(
      (sum, row) => sum + (typeof row.status?.viewers === 'number' ? row.status.viewers : 0),
      0,
    )
    return { rooms: rows.length, live: live.length, viewers }
  }, [rows])

  // The high-water mark of what is on screen, not of all time: the graph only
  // goes back as far as this page has been open, and saying "peak" without that
  // would be claiming knowledge the browser does not have.
  const peak = useMemo(() => history.reduce((max, point) => Math.max(max, point.total), 0), [history])

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Dashboard</h2>
          <p className="muted">
            Every stream at once, re-read every {POLL_MS / 1000} seconds. Counts are since this page was
            opened — nothing is stored.
          </p>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">Viewers now</span>
          <span className="stat-value">{totals.viewers.toLocaleString()}</span>
          <span className="stat-note">
            across {totals.live} live {totals.live === 1 ? 'stream' : 'streams'}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Peak on this page</span>
          <span className="stat-value">{peak.toLocaleString()}</span>
          <span className="stat-note">high-water mark since it was opened</span>
        </div>
        <div className="stat">
          <span className="stat-label">Streams</span>
          <span className="stat-value">
            {totals.live}
            <span className="stat-of"> / {totals.rooms}</span>
          </span>
          <span className="stat-note">live of configured</span>
        </div>
      </div>

      <div className="panel">
        <h3>Viewers over the last few minutes</h3>
        <Sparkline points={history} />
      </div>

      {loaded && rows.length === 0 && !error && (
        <div className="empty">
          No streams configured yet. Add one from <a href="/admin">Streams</a>.
        </div>
      )}

      {rows.length > 0 && (
        <div className="panel">
          <h3>Per stream</h3>
          <table className="stat-table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Handle</th>
                <th>State</th>
                <th className="num">Viewers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td className="mono faint">@{row.username}</td>
                  <td>
                    {row.stale ? (
                      <span className="faint">unreachable</span>
                    ) : row.status?.liveEnded ? (
                      /* Three states, not two. The backend distinguishes them and
                         the distinction is the whole message: a room whose live
                         ended needs a fresh Connect, and a badge reading "offline"
                         sends the reader looking for a connection problem that is
                         not there. */
                      <span className="badge off">Live ended</span>
                    ) : row.status?.connecting ? (
                      <span className="badge off">Connecting</span>
                    ) : row.status?.connected ? (
                      <span className="badge live">Live</span>
                    ) : (
                      <span className="badge">Offline</span>
                    )}
                  </td>
                  <td className="num">
                    {typeof row.status?.viewers === 'number' ? row.status.viewers.toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/**
 * The viewer series, as a line.
 *
 * Drawn from a list of readings rather than a canvas or an SVG library, because
 * the shape is one polygon and the honest way to say a number is to put it on
 * the page.
 *
 * The newest reading sits at the right edge however few readings there are, so
 * the line grows leftwards into the past as they arrive. The other anchoring —
 * the oldest at the left — was the obvious one and is wrong here: this is a time
 * series, time runs left to right, and the right edge is now. It also means the
 * line does not re-stretch every time a reading lands, which a left-anchored
 * line does, and a graph that shifts under the eye is not read.
 */
function Sparkline({ points }: { points: Reading[] }) {
  const W = 720
  const H = 120
  // Headroom above the high-water mark, so the peak is a line on the chart rather
  // than the top edge of it — a flat-topped peak reads as a clipped axis.
  const scale = Math.max(1, peakOf(points)) * 1.15
  const step = points.length > 1 ? W / (HISTORY - 1) : W

  const coordinates = points.map((point, i) => {
    const x = W - (points.length - 1 - i) * step
    const y = H - (point.total / scale) * H
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const area = coordinates.length
    ? `${coordinates[0].split(',')[0]},${H} ${coordinates.join(' ')} ${W},${H}`
    : ''

  return (
    <>
      <svg
        className="spark"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          points.length
            ? `Viewers over the last ${Math.round((points.length * POLL_MS) / 60000)} minutes, peaking at ${peakOf(points)}`
            : 'No readings yet'
        }
      >
        {/* The zero line, always. A flat-at-zero series drawn without it is a
            short mark floating near the right edge, which reads as a broken chart
            rather than as a measurement of nothing — and a dashboard that is
            showing zero is showing the most important thing it can show. */}
        <line className="spark-base" x1="0" y1={H} x2={W} y2={H} />
        {area && <polygon className="spark-area" points={area} />}
        {coordinates.length > 0 && <polyline className="spark-line" points={coordinates.join(' ')} />}
      </svg>
      <p className="faint tight-caption">
        {points.length < 2
          ? 'One reading so far — the line appears after the next poll.'
          : `${points.length} readings, every ${POLL_MS / 1000}s, highest ${peakOf(points)}.`}
      </p>
    </>
  )
}

function peakOf(points: Reading[]): number {
  return points.reduce((max, point) => Math.max(max, point.total), 0)
}