/**
 * The backend's own health and counters, as a page.
 *
 * `/health` answers "is it up and what is it reading"; `/metrics` answers
 * "how much work has it done". Both exist for an orchestrator to scrape —
 * this page is the human-readable form of the same numbers, so an operator
 * can answer "has anything dropped" without knowing the endpoint exists.
 *
 * Polls every 5s: the numbers move slowly, but a socket that dropped is
 * worth seeing sooner than the next time somebody thinks to look.
 */

'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, isAuthFailure } from '@/lib/client'
import type { HealthData, MetricsData } from '@/lib/types'

const POLL_MS = 5000

function uptime(seconds: number): string {
  const whole = Math.floor(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export default function Status() {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [metrics, setMetrics] = useState<MetricsData | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  const read = useCallback(async () => {
    try {
      const [h, m] = await Promise.all([api.health(), api.metrics()])
      setHealth(h)
      setMetrics(m)
      setError('')
    } catch (cause) {
      setError(
        cause instanceof Error && 'status' in cause && isAuthFailure(Number((cause as { status: unknown }).status))
          ? 'The dashboard could not authenticate to the backend. Check STREAMKIT_TOKEN.'
          : cause instanceof Error
            ? cause.message
            : 'Status could not be loaded',
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

  const rooms = health?.rooms ?? {}
  const roomList = Object.entries(rooms)

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Status</h2>
          <p className="muted">
            Backend uptime, connections, and per-room state.
          </p>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : !health || !metrics ? (
        <div className="panel">
          <h3>No data</h3>
          <p className="muted">The backend did not answer.</p>
        </div>
      ) : (
        <>
          <dl className="session-grid analytics-summary">
            <div>
              <dt>Status</dt>
              <dd>{health.status}</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{uptime(health.uptimeSeconds)}</dd>
            </div>
            <div>
              <dt>Active rooms</dt>
              <dd>{health.activeRooms}</dd>
            </div>
            <div>
              <dt>Sockets</dt>
              <dd>{metrics.websocket_connections}</dd>
            </div>
            <div>
              <dt>Queued messages</dt>
              <dd>{metrics.queued_messages_total.toLocaleString()}</dd>
            </div>
          </dl>

          <div className="panel">
            <h3>Per room</h3>
            {roomList.length === 0 ? (
              <p className="muted">No rooms have connected yet.</p>
            ) : (
              roomList.map(([id, room]) => (
                <article key={id} className="stream-row">
                  <header>
                    <strong>{room.message || id.slice(0, 8)}</strong>
                    {room.connected && <span className="badge live">live</span>}
                    {room.connecting && !room.connected && (
                      <span className="badge">{room.waiting ? 'waiting' : 'connecting'}</span>
                    )}
                  </header>
                  <dl className="session-grid">
                    <div>
                      <dt>Viewers</dt>
                      <dd>{room.viewers ? room.viewers.toLocaleString() : '—'}</dd>
                    </div>
                    <div>
                      <dt>Room ID</dt>
                      <dd className="mono">{id.slice(0, 8)}</dd>
                    </div>
                  </dl>
                </article>
              ))
            )}
          </div>

          <div className="panel">
            <h3>Counters</h3>
            <dl className="session-grid">
              <div>
                <dt>Sources active</dt>
                <dd>{metrics.sources_active}</dd>
              </div>
              <div>
                <dt>Disconnected clients</dt>
                <dd>{metrics.clients_disconnected_total.toLocaleString()}</dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </>
  )
}
