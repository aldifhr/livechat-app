'use client'

/**
 * The giveaway hub.
 *
 * `/giveaways` used to be a list of published snapshots and nothing else — the
 * full picker lived only under a single stream, so running a giveaway meant
 * knowing which stream's page to open first. This is the front door: pick a
 * stream, run the whole thing (collect entries, review, spin, publish), and see
 * what has already been published, all on one page.
 *
 * The picker itself is `GiveawayRunner`, unchanged — the same state machine the
 * stream page mounts. Nothing about the draw is reimplemented here; this only
 * chooses which stream it runs against and sits the snapshot list underneath.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/client/api'
import type { GiveawaySnapshot, Room } from '@/lib/types'
import GiveawayRunner from '@/sections/GiveawayRunner'
import ConfirmDialog from '@/components/ConfirmDialog'

const POLL_MS = 15_000

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

/** The stream the picker is running against. */
function StreamPicker({
  rooms,
  selected,
  onSelect,
}: {
  rooms: Room[]
  selected: string
  onSelect: (id: string) => void
}) {
  if (rooms.length === 0) {
    return (
      <div className="empty">
        No streams yet. Connect a TikTok username from <Link href="/streams">Streams</Link> first.
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {rooms.map((room) => {
        const active = room.id === selected
        return (
          <button
            key={room.id}
            type="button"
            onClick={() => onSelect(room.id)}
            aria-pressed={active}
            className={
              active
                ? 'border-2 border-accent bg-accent font-extrabold text-accent-ink'
                : undefined
            }
          >
            {room.username ? `@${room.username}` : room.name || room.id.slice(0, 8)}
          </button>
        )
      })}
    </div>
  )
}

export default function GiveawayHub({ backendOrigin }: { backendOrigin: string }) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState('')

  const [snapshots, setSnapshots] = useState<GiveawaySnapshot[]>([])
  const [snapshotsLoaded, setSnapshotsLoaded] = useState(false)
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<GiveawaySnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  // The room list, read once. A stream that is connected is a better default
  // than the first row: a giveaway needs a live room to collect entries from.
  useEffect(() => {
    let cancelled = false
    api
      .rooms()
      .then(({ rooms: found }) => {
        if (cancelled) return
        setRooms(found)
        const live = found[0]
        if (live) setSelected(live.id)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const loadSnapshots = useCallback(async () => {
    try {
      const { snapshots: found } = await api.giveawaySnapshots()
      setSnapshots(found)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Snapshots could not be loaded')
    } finally {
      setSnapshotsLoaded(true)
    }
  }, [])

  useEffect(() => {
    void loadSnapshots()
    const timer = window.setInterval(() => void loadSnapshots(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadSnapshots])

  const confirmDelete = async () => {
    if (!pendingDelete) return
    const { id } = pendingDelete
    setBusy(true)
    try {
      await api.deleteGiveawaySnapshot(id)
      setSnapshots((current) => current.filter((snap) => snap.id !== id))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The snapshot could not be deleted')
    } finally {
      setBusy(false)
      setPendingDelete(null)
    }
  }

  // The handle the runner resolves. A room with no handle is reachable by its id,
  // the same two forms the profile accepts.
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selected),
    [rooms, selected],
  )
  const handle = selectedRoom?.username || selected

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Giveaways</h2>
          <p className="muted">
            Run a giveaway on a stream — collect entries, review them, spin the winners, then
            publish a public report anyone can check.
          </p>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {!loaded ? (
        <div className="empty">Loading streams…</div>
      ) : (
        <>
          <div className="panel">
            <h3>Which stream?</h3>
            <StreamPicker rooms={rooms} selected={selected} onSelect={setSelected} />
          </div>

          {handle ? (
            <GiveawayRunner key={handle} handle={handle} backendOrigin={backendOrigin} embedded />
          ) : null}
        </>
      )}

      <div className="page-head" style={{ marginTop: '2.5rem' }}>
        <div>
          <h2>Published results</h2>
          <p className="muted">
            Every snapshot published from this app or the desktop app, newest first. Open one to
            see the full report.
          </p>
        </div>
      </div>

      {!snapshotsLoaded ? (
        <div className="panel">
          <p className="muted">Loading snapshots…</p>
        </div>
      ) : snapshots.length === 0 ? (
        <div className="panel">
          <p className="muted">
            Nothing published yet. Finish a draw above and publish it to get a shareable report.
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
