/**
 * The backend's log, as a page.
 *
 * The journal already has this and is the archive; this is the window. The
 * question it answers is "did something just break", and answering that by
 * shelling into the server is a thing you cannot do from a phone at midnight.
 *
 * It polls, like the dashboard, because the backend pushes nothing to the
 * dashboard — it speaks WebSocket to overlays and HTTP to everyone else. A poll
 * every few seconds is the honest way to read a stream of records from a service
 * that does not offer one.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, isAuthFailure } from '@/lib/client/api'
import type { LogEntry, LogPage } from '@/lib/types'

/** How often the log is re-read. Slower than the dashboard's poll: a log page is
 *  read deliberately, and a list that reorders under the cursor while you are
 *  reading a line is worse than one a few seconds behind. */
const POLL_MS = 5000

/** How many records to ask for. The backend keeps 500 and clamps this. */
const LIMIT = 300

/** The level a filter offers, and what it means. A floor, not a match. */
const FILTERS = [
  { value: 'debug', label: 'Everything' },
  { value: 'info', label: 'Info and up' },
  { value: 'warning', label: 'Warnings and up' },
  { value: 'error', label: 'Errors only' },
]

export default function Logs() {
  const [page, setPage] = useState<LogPage | null>(null)
  const [error, setError] = useState('')
  const [level, setLevel] = useState('info')
  const [query, setQuery] = useState('')
  const [paused, setPaused] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Read inside the interval without making it a dependency: a poll that is torn
  // down and rebuilt on every keystroke would restart its clock, and a search
  // would never settle.
  const filter = useRef({ level, query })
  filter.current = { level, query }

  const read = useCallback(async () => {
    try {
      const next = await api.logs({ limit: LIMIT, level: filter.current.level, q: filter.current.query })
      setPage(next)
      setError('')
    } catch (cause) {
      // A credential problem is worth saying differently from a backend that is
      // down: one is fixed in the environment, the other by waiting.
      setError(
        cause instanceof Error && 'status' in cause && isAuthFailure(Number((cause as { status: unknown }).status))
          ? 'The dashboard could not authenticate to the backend. Check STREAMKIT_TOKEN.'
          : cause instanceof Error
            ? cause.message
            : 'The log could not be read',
      )
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void read()
    if (paused) return
    const timer = window.setInterval(() => void read(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [read, paused, level, query])

  const entries = page?.entries ?? []

  // Counted here rather than asked of the backend: the page already has every
  // entry it is showing, and a second request for a number the list implies is a
  // number that can disagree with the list.
  const counts = useMemo(() => {
    const by = { debug: 0, info: 0, warning: 0, error: 0, critical: 0 } as Record<string, number>
    for (const entry of entries) by[entry.level] = (by[entry.level] ?? 0) + 1
    return by
  }, [entries])

  const problems = counts.error + counts.critical
  const hidden = page ? Math.max(0, page.total - entries.length) : 0

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Backend log</h2>
          <p className="muted">
            The last {page?.capacity ?? LIMIT} records the backend has produced, newest first, re-read every{' '}
            {POLL_MS / 1000} seconds. The journal on the server keeps the full history.
          </p>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">Errors</span>
          <span className={`stat-value ${problems ? 'text-bad' : ''}`}>{problems}</span>
          <span className="stat-note">errors and criticals in view</span>
        </div>
        <div className="stat">
          <span className="stat-label">Warnings</span>
          <span className="stat-value">{counts.warning}</span>
          <span className="stat-note">in view</span>
        </div>
        <div className="stat">
          <span className="stat-label">Showing</span>
          <span className="stat-value">
            {entries.length}
            {hidden > 0 && <span className="stat-of"> / {page?.total}</span>}
          </span>
          <span className="stat-note">{hidden > 0 ? `${hidden} more matched the filter` : 'matching the filter'}</span>
        </div>
      </div>

      <div className="panel">
        <div className="log-controls">
          <div className="field">
            <label htmlFor="log-level">Show</label>
            <select id="log-level" value={level} onChange={(event) => setLevel(event.target.value)}>
              {FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="log-search">Search</label>
            <input
              id="log-search"
              type="search"
              placeholder="A handle, a message, a module…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button className={paused ? 'on' : ''} onClick={() => setPaused((was) => !was)}>
            {paused ? 'Paused — resume' : 'Pause'}
          </button>
          <button onClick={() => void read()}>Refresh</button>
        </div>

        {!loaded ? (
          <p className="faint">Reading…</p>
        ) : entries.length === 0 ? (
          <div className="empty">
            {query
              ? `Nothing matching “${query}” at this level.`
              : 'Nothing at this level yet. The backend has been quiet — which is what a healthy one looks like.'}
          </div>
        ) : (
          <ul className="log-entries">
            {entries.map((entry, index) => (
              <LogRow key={`${entry.at}-${index}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

/** One record: when, how bad, who said it, and what. */
function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false)
  const time = new Date(entry.at)
  // Local time, because the person reading it is looking at a clock in the room —
  // and the seconds, because two records a minute apart tell a different story
  // from two in the same second.
  const stamp = Number.isNaN(time.getTime())
    ? entry.at
    : `${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`

  return (
    <li className={`log-entry level-${entry.level}`}>
      <span className="log-time" title={entry.at}>
        {stamp}
      </span>
      <span className={`log-level level-${entry.level}`}>{entry.level}</span>
      <span className="log-source">{entry.source}</span>
      <span className="log-message">
        {entry.message}
        {entry.traceback && (
          <>
            {' '}
            <button className="log-more" onClick={() => setOpen((was) => !was)}>
              {open ? 'hide trace' : 'trace'}
            </button>
            {open && <pre className="log-trace">{entry.traceback}</pre>}
          </>
        )}
      </span>
    </li>
  )
}
