/**
 * What every stream has produced, in one place.
 *
 * The dashboard answers "what is happening now" and the logs page answers "did
 * something break". This answers the third question: which stream had the most
 * viewers, which ran the longest, who gave the most. All of it from the backend's
 * own eventlog counters — no second definition of any number.
 */

'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, isAuthFailure } from '@/lib/client/api'
import { formatDuration } from '@/lib/format'
import type { AnalyticsSummary, SessionPerson } from '@/lib/types'

type RoomRow = AnalyticsSummary['rooms'][number]

const POLL_MS = 15_000

/**
 * What the bar chart can be read against.
 *
 * Each carries how to take the number and how to print it, rather than the chart
 * casting through `row[key] as number`. That is not tidiness for its own sake: two
 * of these are not the field's own type — `live_seconds` is nullable, and its
 * number is seconds while what a reader wants is `7m` — so a chart that assumed one
 * accessor and one formatter would either be lying about uptime or have to special
 * case it in the render.
 */
const METRICS = [
  { key: 'viewers', label: 'Viewers', read: (r: RoomRow) => r.viewers, show: (n: number) => n.toLocaleString() },
  { key: 'peak_viewers', label: 'Peak', read: (r: RoomRow) => r.peak_viewers, show: (n: number) => n.toLocaleString() },
  { key: 'total_diamonds', label: 'Diamonds', read: (r: RoomRow) => r.total_diamonds, show: (n: number) => n.toLocaleString() },
  { key: 'events', label: 'Events', read: (r: RoomRow) => r.events, show: (n: number) => n.toLocaleString() },
  { key: 'live_seconds', label: 'Uptime', read: (r: RoomRow) => r.live_seconds ?? 0, show: formatDuration },
] as const

type Metric = (typeof METRICS)[number]
type MetricKey = Metric['key']

/**
 * One horizontal bar per stream, read against the selected metric.
 *
 * Divs rather than SVG, which is a departure from the viewer trend next door and
 * is deliberate. That one is a time series with a real axis and two crossing lines,
 * which is what SVG is for. This is a ranked list of named categories with one
 * number each — a table with a bar in the middle column. Drawn as elements it is
 * fluid with no measuring, the text never distorts as the window changes, and a
 * long handle is one `min-width` away from fitting.
 *
 * Horizontal because the categories are TikTok handles, which are long and do not
 * rotate, sit or truncate well in a column along the left of a vertical bar.
 */
function BarChart({ data, metric }: { data: AnalyticsSummary; metric: Metric }) {
  // Sorted here rather than mutating `data.rooms`, which is the list the tiles
  // above were built from and which the backend already ordered by viewers.
  const rows = [...data.rooms].sort((a, b) => metric.read(b) - metric.read(a))
  // 1 rather than 0 so a session where everything is zero still divides. The bars
  // are then all empty, which is what zero is.
  const max = Math.max(1, ...rows.map(metric.read))

  return (
    <ul className="bar-chart">
      {rows.map((row) => (
        <li key={row.id} className="bar-row">
          <span className="bar-name" title={`@${row.username || 'unknown'}`}>
            @{row.username || 'unknown'}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(metric.read(row) / max) * 100}%` }} />
          </span>
          <span className="bar-value">{metric.show(metric.read(row))}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The most active people, summed across every stream.
 *
 * A bar chart here would be a chart of ten numbers with one label each, which is
 * the same information twice; a ranked list is the form that lets a name be read,
 * which is the only reason anyone looks at it.
 */
function Leaderboard({
  title,
  people,
  unit,
  empty,
}: {
  title: string
  people: SessionPerson[]
  unit: string
  empty: string
}) {
  return (
    <div className="leaderboard">
      <h4 className="leaderboard-title">{title}</h4>
      {people.length === 0 ? (
        <p className="faint leaderboard-empty">{empty}</p>
      ) : (
        <ol className="leaderboard-list">
          {people.map((person, index) => (
            <li key={person.id} className="leaderboard-row">
              <span className="leaderboard-rank">{index + 1}</span>
              <span className="leaderboard-name">{person.nickname}</span>
              <span className="leaderboard-value">
                {((person.diamonds ?? 0) as number).toLocaleString()} {unit}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export default function Analytics() {
  const [data, setData] = useState<AnalyticsSummary | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  // Which number the bars are read against. Local state rather than the URL: it is
  // a lens over one page rather than a place worth sending somebody, and every
  // other address in the console names a room or a job rather than a viewpoint.
  const [metric, setMetric] = useState<MetricKey>('viewers')
  const read = useCallback(async () => {
    try {
      setData(await api.analytics())
      setError('')
    } catch (cause) {
      setError(
        cause instanceof Error && 'status' in cause && isAuthFailure(Number((cause as { status: unknown }).status))
          ? 'The dashboard could not authenticate to the backend. Check STREAMKIT_TOKEN.'
          : cause instanceof Error
            ? cause.message
            : 'Analytics could not be loaded',
      )
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void read()
    const timer = window.setInterval(() => void read(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [read])

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Analytics</h2>
          <p className="muted">
            Session totals across every stream — viewers, events, diamonds, and uptime.
          </p>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : !data || data.total_rooms === 0 ? (
        <div className="panel">
          <h3>No streams yet</h3>
          <p className="muted">Connect a TikTok username and this page will show what the session produced.</p>
        </div>
      ) : (
        <>
          {/* Five headline numbers, in the same tiles the overview uses.
              It was a `session-grid` before, which is a two-column list with each
              value pushed to the far edge of its half — right for a panel holding
              one stream's session, and wrong across a whole page, where it read as
              a table whose columns had drifted apart. Five items in two columns
              also left the last row holding one, so the numbers did not line up. */}
          <div className="stat-row analytics-totals">
            <div className="stat">
              <span className="stat-label">Streams</span>
              <span className="stat-value">{data.total_rooms}</span>
              <span className="stat-note">configured</span>
            </div>
            <div className="stat">
              <span className="stat-label">Viewers now</span>
              <span className="stat-value">{data.total_viewers.toLocaleString()}</span>
              <span className="stat-note">across every live stream</span>
            </div>
            <div className="stat">
              <span className="stat-label">Peak viewers</span>
              <span className="stat-value">{data.total_peak_viewers.toLocaleString()}</span>
              <span className="stat-note">each stream's own high-water mark</span>
            </div>
            <div className="stat">
              <span className="stat-label">Diamonds</span>
              <span className="stat-value">{data.total_diamonds.toLocaleString()}</span>
              <span className="stat-note">gifted this session</span>
            </div>
            <div className="stat">
              <span className="stat-label">Events</span>
              <span className="stat-value">{data.total_events.toLocaleString()}</span>
              <span className="stat-note">comments, gifts, joins</span>
            </div>
          </div>

          <h3 className="section-heading">Per stream</h3>
          {/* The lens, then the bars it is looking through. */}
          <div className="chart-controls">
            <div className="seg">
              {METRICS.map((option) => (
                <button
                  key={option.key}
                  className={metric === option.key ? 'on' : ''}
                  onClick={() => setMetric(option.key)}
                  aria-pressed={metric === option.key}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <BarChart data={data} metric={METRICS.find((option) => option.key === metric) ?? METRICS[0]} />

          <h3 className="section-heading">Across every stream</h3>
          <div className="leaderboards">
            <Leaderboard
              title="Top gifters"
              people={data.topGifters ?? []}
              unit="diamonds"
              empty="No gifts this session."
            />
          </div>
          {/* Said once, where the numbers it qualifies are, rather than as a
              tooltip on each. The ceiling is a property of the data and the reader
              is owed it before they draw a conclusion from the ranking. */}
          <p className="faint tight-caption leaderboard-note">
            Summed across every stream on the same account. These are the top twenty of each
            stream added together, so somebody ranked below that on every stream is not shown —
            and nothing here survives a backend restart.
          </p>
        </>
      )}
    </>
  )
}
