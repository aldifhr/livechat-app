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
          <dl className="session-grid analytics-summary">
            <div>
              <dt>Streams</dt>
              <dd>{data.total_rooms}</dd>
            </div>
            <div>
              <dt>Viewers now</dt>
              <dd>{data.total_viewers.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Peak viewers</dt>
              <dd>{data.total_peak_viewers.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Diamonds</dt>
              <dd>{data.total_diamonds.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>{data.total_events.toLocaleString()}</dd>
            </div>
          </dl>

          <div className="panel">
            <h3>Per stream</h3>
            {data.rooms.map((room) => (
              <article key={room.id} className="stream-row">
                <header>
                  <strong>@{room.username || 'unknown'}</strong>
                  {room.connected && <span className="badge live">live</span>}
                </header>
                <dl className="session-grid">
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
