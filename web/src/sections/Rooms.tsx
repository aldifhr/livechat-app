/**
 * The rooms the backend knows about.
 *
 * Each room is one stream the backend is watching. The list is the console's home
 * because every other thing here is an argument to it: an overlay link needs a
 * room, and a room is what connects to TikTok in the first place.
 */

'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, isAuthFailure, type Room } from '../lib/client'

/** How often to ask about a room's live state. Long enough to be quiet, short
 *  enough that going offline is noticed while somebody is watching. */
const POLL_MS = 15_000

export default function Rooms({ onStyleOverlay }: { onStyleOverlay: (roomId: string) => void }) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [newHandle, setNewHandle] = useState('')
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

  /**
   * Connect a handle, which creates its room if needed.
   *
   * Connecting rather than creating is the whole point: a room nothing is
   * connected to is a row in a list, not a chat. An existing room for the same
   * handle is reused, so a second visit keeps its config instead of making a
   * twin that says the same thing.
   */
  const connect = async () => {
    const handle = newHandle.trim().replace(/^@/, '')
    if (handle === '') return
    setBusy(true)
    try {
      // The label is applied afterwards rather than sent with the connect, so a
      // label typed for one stream does not end up naming the next one when the
      // backend reuses an existing room instead of making a new one.
      const room = await api.connectHandle(handle)
      const label = newName.trim()
      if (label && label !== room.name) {
        try {
          await api.updateRoom(room.id, { name: label })
        } catch {
          // The stream is connected either way; a label that would not save is
          // not a reason to tell the operator the connect failed.
        }
      }
      setNewHandle('')
      setNewName('')
      setError('')
      setNotice(`Connected to @${handle}.`)
      // A room that was just created is not in the list yet, so this cannot
      // wait for the next poll to show the streamer's own room.
      setRooms((current) => (current.some((r) => r.id === room.id) ? current : [room, ...current]))
    } catch (cause) {
      setNotice('')
      setError(
        cause instanceof ApiError && isAuthFailure(cause.status)
          ? 'Your login was refused. Reload the page and sign in again.'
          : cause instanceof ApiError
            ? cause.message
            : 'The handle could not be connected',
      )
    } finally {
      setBusy(false)
    }
  }

  /** Create a room with no handle yet — for a stream that is not live. */
  const create = async () => {
    if (newName.trim() === '') return
    setBusy(true)
    try {
      await api.createRoom(newName.trim())
      setNewName('')
      await load()
    } catch (cause) {
      setNotice('')
      setError(
        cause instanceof ApiError && isAuthFailure(cause.status)
          ? 'Your login was refused. Reload the page and sign in again.'
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
      // Same treatment as create: a refused token and a backend that is down are
      // different problems, and the raw "Invalid or missing STREAMKIT_TOKEN" says
      // nothing about which one happened or what to do about it.
      setError(
        cause instanceof ApiError && isAuthFailure(cause.status)
          ? 'Your login was refused. Reload the page and sign in again.'
          : cause instanceof ApiError
            ? cause.message
            : 'The room could not be deleted',
      )
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
      {notice && <div className="notice ok">{notice}</div>}

      <div className="panel">
        <h3>Connect a stream</h3>
        <div className="row">
          <input
            className="grow"
            placeholder="TikTok username — with or without the @"
            value={newHandle}
            onChange={(event) => setNewHandle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void connect()}
            aria-label="TikTok username"
          />
          <input
            placeholder="Label (optional)"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            aria-label="Room label"
          />
          <button className="primary" onClick={() => void connect()} disabled={busy || newHandle.trim() === ''}>
            Connect
          </button>
        </div>
        <p className="faint" style={{ margin: '0.4rem 0 0' }}>
          The room is created for you and starts watching straight away. Connecting a handle that already has
          a room reuses it and keeps its styling.
        </p>
      </div>

      <div className="panel">
        <h3>Add an empty room</h3>
        <div className="row">
          <input
            className="grow"
            placeholder="Room name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void create()}
            aria-label="Room name"
          />
          <button onClick={() => void create()} disabled={busy || newName.trim() === ''}>
            Add room
          </button>
        </div>
        <p className="faint" style={{ margin: '0.4rem 0 0' }}>
          For a stream that is not live yet — nothing is watched until a handle is connected.
        </p>
      </div>

      {rooms.length === 0 ? (
        <div className="empty">No rooms yet. Connect a username above and its room appears here.</div>
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
              <button onClick={() => onStyleOverlay(room.id)}>Style the overlay</button>
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