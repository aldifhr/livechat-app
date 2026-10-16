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
import { api, isAuthFailure } from '@/lib/client'
import type { AnalyticsSummary } from '@/lib/types'

const POLL_MS = 15_000

function duration(seconds: number | null): string {
  if (!seconds) return '—'
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export default function Analytics() {
  const [data, setData] = useState<AnalyticsSummary | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

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
          {/* A grid of cards, not one full-width row each. Five streams at a page
              wide meant each card was a name and a handful of figures with two
              thirds of the screen empty beside it. */}
          <div className="analytics-grid">
            {data.rooms.map((room) => (
              <article key={room.id} className="analytics-card">
                <header className="analytics-card-head">
                  <span className="analytics-card-name">
                    @{room.username || 'unknown'}
                    {room.connected && <span className="badge live">live</span>}
                  </span>
                </header>
                <dl className="analytics-figures">
                  <div>
                    <dt>Viewers</dt>
                    <dd>{room.viewers.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Peak</dt>
                    <dd>{room.peak_viewers.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Diamonds</dt>
                    <dd>{room.total_diamonds.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Events</dt>
                    <dd>{room.events.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>{duration(room.live_seconds)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  )
}
