'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/client/api'
import ConfirmDialog from '@/components/ConfirmDialog'
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
  const [pendingDelete, setPendingDelete] = useState<GiveawaySnapshot | null>(null)
  const [busy, setBusy] = useState(false)

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

  const confirmDelete = async () => {
    if (!pendingDelete) return
    const { id } = pendingDelete
    setBusy(true)
    try {
      await api.deleteGiveawaySnapshot(id)
      // Dropped from the list at once rather than waiting for the next poll, so the
      // row does not linger after the operator has seen the confirmation.
      setSnapshots((current) => current.filter((snap) => snap.id !== id))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The snapshot could not be deleted')
    } finally {
      setBusy(false)
      setPendingDelete(null)
    }
  }

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
          <div className="overflow-x-auto">
            <table className="stat-table">
              <thead>
                <tr>
                  <th>Stream</th>
                  <th>Published</th>
                  <th className="num">Entrants</th>
                  <th className="num">Winners</th>
                  <th>Test</th>
                  <th aria-label="Report"></th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => (
                  <tr key={snap.id}>
                    <td className="mono faint">
                      {snap.report.streamHandle ? `@${snap.report.streamHandle}` : '—'}
                    </td>
                    <td>{formatDate(snap.createdAt)}</td>
                    <td className="num">{snap.report.entrantCount.toLocaleString()}</td>
                    <td className="num">{snap.report.winnerCount.toLocaleString()}</td>
                    <td>
                      {snap.report.isTestRun ? <span className="badge">test</span> : <span className="faint">—</span>}
                    </td>
                    <td className="num">
                      <div className="flex items-center justify-end gap-3">
                        <Link className="quiet-link" href={`/giveaway/${snap.id}`}>
                          Open
                        </Link>
                        <button className="danger" type="button" onClick={() => setPendingDelete(snap)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this snapshot?"
        body={
          <p className="flush-top">
            The public link <code>/giveaway/{pendingDelete?.id}</code> will stop resolving for anyone who
            has it. This cannot be undone.
          </p>
        }
        confirmLabel="Delete snapshot"
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}
