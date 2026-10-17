'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/client'
import type { GiveawaySnapshot } from '@/lib/types'

const POLL_MS = 15_000

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export default function GiveawaysPage() {
  const [snapshots, setSnapshots] = useState<GiveawaySnapshot[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const { snapshots } = await api.giveawaySnapshots()
      setSnapshots(snapshots)
      setError('')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Snapshots could not be loaded',
      )
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Giveaway snapshots</h2>
          <p className="muted">
            Published giveaway results, newest first. Open one to see the full report.
          </p>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {!loaded ? (
        <div className="panel">
          <p className="muted">Loading snapshots…</p>
        </div>
      ) : snapshots.length === 0 ? (
        <div className="panel">
          <p className="muted">
            No snapshots yet. Publish one from the desktop app after a giveaway draw.
          </p>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Stream</th>
                <th>Published</th>
                <th>Entrants</th>
                <th>Winners</th>
                <th>Test</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap) => (
                <tr key={snap.id}>
                  <td>@{snap.report.streamHandle || '—'}</td>
                  <td>{formatDate(snap.createdAt)}</td>
                  <td>{snap.report.entrantCount}</td>
                  <td>{snap.report.winnerCount}</td>
                  <td>{snap.report.isTestRun ? 'yes' : 'no'}</td>
                  <td>
                    <Link className="quiet-link" href={`/giveaway/${snap.id}`}>
                      Open
                    </Link>
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
