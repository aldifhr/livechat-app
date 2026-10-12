/**
 * The rooms the backend knows about.
 *
 * Each room is one stream the backend is watching. The list is the console's home
 * because every other thing here is an argument to it: an overlay link needs a
 * room, and a room is what connects to TikTok in the first place.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, isAuthFailure, type Room } from '../lib/api'

/** How often to ask about a room's live state. Long enough to be quiet, short
 *  enough that going offline is noticed while somebody is watching. */
const POLL_MS = 15_000

export default function Rooms({ onOpenOverlay }: { onOpenOverlay: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [live, setLive] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      const { rooms: found } = await api.rooms()
      setRooms(found)
      setError('')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The room list could not be loaded')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // Status is asked per room rather than derived from the list, because the list
  // endpoint does not carry it — a room that was created by a test is not
  // necessarily connected, and showing both as "live" would be a lie.
  useEffect(() => {
    if (rooms.length === 0) return
    let cancelled = false

    const check = async () => {
      const results = await Promise.all(
        rooms.map(async (room) => {
          try {
            const status = await api.status(room.id)
            return [room.id, status.connected] as const
          } catch {
            // A status that cannot be read is not evidence the room is down, so
            // the room is left out and keeps whatever it last showed. Reporting
            // it as offline would be a guess dressed as a reading.
            return null
          }
        }),
      )
      if (cancelled) return
      setLive((current) => {
        const next = { ...current }
        for (const entry of results) if (entry) next[entry[0]] = entry[1]
        return next
      })
    }

    void check()
    const timer = window.setInterval(() => void check(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [rooms])

  const create = async () => {
    if (newName.trim() === '') return
    setBusy(true)
    try {
      await api.createRoom(newName.trim())
      setNewName('')
      await load()
    } catch (cause) {
      // The token being wrong and the room name being taken are different
      // problems, so the message has to say which one this was.
      setError(
        cause instanceof ApiError && isAuthFailure(cause.status)
          ? 'The token was refused. Check it above and try again.'
          : cause instanceof ApiError
            ? cause.message
            : 'The room could not be created',
      )
    } finally {
      setBusy(false)
    }
  }

  const remove = async (room: Room) => {
    if (!window.confirm(`Delete "${room.name}"? The overlay link for it stops working immediately.`)) return
    setBusy(true)
    try {
      await api.deleteRoom(room.id)
      await load()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The room could not be deleted')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Rooms</h2>
          <p className="muted" style={{ margin: 0 }}>
            Every stream the backend is watching. A room is what an overlay link points at.
          </p>
        </div>
        <div className="actions">
          <button onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="panel">
        <div className="row">
          <input
            className="grow"
            placeholder="New room name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void create()}
          />
          <button className="primary" onClick={() => void create()} disabled={busy || newName.trim() === ''}>
            Add room
          </button>
        </div>
        <p className="faint" style={{ margin: '0.4rem 0 0' }}>
          Needs the API token above. Reading this list does not.
        </p>
      </div>

      {rooms.length === 0 ? (
        <div className="empty">No rooms yet. Add one above, then connect it to a handle in the desktop app.</div>
      ) : (
        rooms.map((room) => (
          <div className="panel" key={room.id}>
            <div className="row">
              <div className="grow">
                <div className="name">
                  {room.name} <span className={live[room.id] ? 'badge live' : 'badge off'}>{live[room.id] ? 'live' : 'not connected'}</span>
                </div>
                <div className="faint mono">{room.username || 'no handle connected yet'}</div>
              </div>
              <button onClick={onOpenOverlay}>Style the overlay</button>
              <button
                className="danger"
                onClick={() => void remove(room)}
                disabled={busy}
                aria-label={`Delete ${room.name}`}
              >
                Delete
              </button>
            </div>
          </div>
        ))
      )}
    </>
  )
}