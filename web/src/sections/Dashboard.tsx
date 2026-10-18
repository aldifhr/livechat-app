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

import { useCallback, useMemo, useState } from 'react'
import { api } from '@/lib/client/api'
import { usePoll } from '@/hooks/usePoll'
import type { Room, RoomStatus } from '@/lib/types'
import NumberTicker from '@/components/magicui/NumberTicker'
import RoomStateBadge from '@/components/RoomStateBadge'

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
    const connected = readings.filter((row) => row.status?.connected)
    const countsComplete = connected.every((row) => typeof row.status?.viewers === 'number')
    const total = connected.reduce((sum, row) => sum + (row.status?.viewers ?? 0), 0)
    const answered = readings.some((row) => row.status)
    if (answered && (connected.length === 0 || countsComplete)) {
      setHistory((current) => [...current, { at: Date.now(), total }].slice(-HISTORY))
    }
  }, [])

  usePoll(() => void poll(), POLL_MS)

  const totals = useMemo(() => {
    const live = rows.filter((row) => row.status?.connected)
    const countsComplete = live.every((row) => typeof row.status?.viewers === 'number')
    const viewers = live.length === 0
      ? 0
      : countsComplete
        ? live.reduce((sum, row) => sum + (row.status?.viewers ?? 0), 0)
        : null
    return { rooms: rows.length, live: live.length, viewers }
  }, [rows])

  // The high-water mark of what is on screen, not of all time: the graph only
  // goes back as far as this page has been open, and saying "peak" without that
  // would be claiming knowledge the browser does not have. The chart draws its
  // own scale from the same reading, so both call `peakOf` rather than each
  // reducing the series its own way.
  const peak = peakOf(history)

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Overview</h2>
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
          <span className="stat-value">
            {totals.viewers === null ? '—' : <NumberTicker value={totals.viewers} />}
          </span>
          <span className="stat-note">
            across {totals.live} live {totals.live === 1 ? 'stream' : 'streams'}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Peak on this page</span>
          <span className="stat-value">
            {history.length ? <NumberTicker value={peak} /> : '—'}
          </span>
          <span className="stat-note">high-water mark since it was opened</span>
        </div>
        <div className="stat">
          <span className="stat-label">Streams</span>
          <span className="stat-value">
            <NumberTicker value={totals.live} />
            <span className="stat-of"> / <NumberTicker value={totals.rooms} /></span>
          </span>
          <span className="stat-note">live of configured</span>
        </div>
      </div>

      <div className="panel">
        <h3>Viewers trend</h3>
        <ViewerChart points={history} />
      </div>

      {loaded && rows.length === 0 && !error && (
        <div className="empty">
          No streams configured yet. Add one from <a href="/admin/streams">Streams</a>.
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
                    ) : (
                      <RoomStateBadge status={row.status} />
                    )}
                  </td>
                  <td className="num">
                    {row.status?.connected && typeof row.status.viewers === 'number'
                      ? row.status.viewers.toLocaleString()
                      : '—'}
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
 * The viewer series, as a line chart.
 *
 * Drawn as SVG rather than pulled from a charting library: the shape is one
 * polyline over a fixed set of readings, and a library for that would be a
 * dependency, a bundle and a styling surface to keep in step with the theme for a
 * graph the theme already has colours for. It was a sparkline before — a bare line
 * with no axes — which showed the shape and hid every number behind it: you could
 * see the line rise and not tell whether it went from 3 to 8 or from 3,000 to 8,000.
 *
 * The newest reading sits at the right edge however few readings there are, so the
 * line grows leftwards into the past as they arrive. The other anchoring — the
 * oldest at the left — was the obvious one and is wrong here: this is a time
 * series, time runs left to right, and the right edge is now. It also means the
 * line does not re-stretch every time a reading lands, which a left-anchored line
 * does, and a graph that shifts under the eye is not read.
 */
function ViewerChart({ points }: { points: Reading[] }) {
  const W = 720
  const H = 200
  // Room for the y-axis labels on the left and the time labels under the plot.
  const PAD = { top: 12, right: 12, bottom: 26, left: 48 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  // Headroom above the high-water mark, so the peak is a line on the chart rather
  // than the top edge of it — a flat-topped peak reads as a clipped axis.
  const peak = peakOf(points)
  const scale = Math.max(1, peak) * 1.15
  const step = points.length > 1 ? plotW / (HISTORY - 1) : plotW

  const x = (i: number) => PAD.left + plotW - (points.length - 1 - i) * step
  const y = (value: number) => PAD.top + plotH - (value / scale) * plotH

  const coordinates = points.map((point, i) => `${x(i).toFixed(1)},${y(point.total).toFixed(1)}`)
  const area = coordinates.length
    ? `${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)} ${coordinates.join(' ')} ${x(points.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)}`
    : ''

  // Four gridlines, top to bottom, each labelled with the value it stands for.
  // Derived from the same `scale` the line is drawn against, so a label can never
  // disagree with the height it sits at.
  const ticks = [0, 1, 2, 3].map((n) => {
    const value = (scale / 3) * n
    return { value, y: y(value) }
  })

  const elapsedMs = points.length > 1 ? points[points.length - 1].at - points[0].at : 0
  const elapsedLabel = elapsedMs < 60_000
    ? `${Math.round(elapsedMs / 1000)} seconds`
    : `${(elapsedMs / 60_000).toFixed(1)} minutes`
  const last = points[points.length - 1]

  return (
    <>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={
          points.length
            ? `Viewers over the last ${points.length === 1 ? 'first reading' : elapsedLabel}, now ${last?.total ?? 0}, peaking at ${peak}`
            : 'No readings yet'
        }
      >
        {/* The grid, behind everything. Values are rounded for display only — the
            lines themselves sit at the exact positions the data is drawn against. */}
        {ticks.map((tick) => (
          <g key={tick.value}>
            <line className="chart-grid" x1={PAD.left} y1={tick.y} x2={W - PAD.right} y2={tick.y} />
            <text className="chart-axis" x={PAD.left - 8} y={tick.y + 4} textAnchor="end">
              {Math.round(tick.value).toLocaleString()}
            </text>
          </g>
        ))}

        {area && <polygon className="chart-area" points={area} />}
        {coordinates.length > 0 && <polyline className="chart-line" points={coordinates.join(' ')} />}

        {/* The newest reading, marked. Without it a line ending mid-chart looks
            like data that stopped rather than a number that is still current. */}
        {last && <circle className="chart-point" cx={x(points.length - 1)} cy={y(last.total)} r={4} />}

        {/* Time runs left to right, so the ends are the only two labels needed:
            the first reading and now. */}
        {points.length > 1 && (
          <>
            <text className="chart-axis" x={PAD.left} y={H - 6} textAnchor="start">
              {elapsedLabel} ago
            </text>
            <text className="chart-axis" x={W - PAD.right} y={H - 6} textAnchor="end">
              now
            </text>
          </>
        )}
      </svg>
      <p className="faint tight-caption">
        {points.length < 2
          ? 'One reading so far — the line appears after the next poll.'
          : `${points.length} readings, every ${POLL_MS / 1000}s · now ${last?.total ?? 0} · highest ${peak}.`}
      </p>
    </>
  )
}

function peakOf(points: Reading[]): number {
  return points.reduce((max, point) => Math.max(max, point.total), 0)
}
