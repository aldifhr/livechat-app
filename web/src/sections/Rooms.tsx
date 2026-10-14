/**
 * The rooms the backend knows about.
 *
 * Each room is one stream the backend is watching. The list is the console's home
 * because every other thing here is an argument to it: an overlay link needs a
 * room, and a room is what connects to TikTok in the first place.
 */

'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, isAuthFailure, type Room } from '../lib/client'
import ConfirmDialog from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'

/** How often to ask about a room's live state. Long enough to be quiet, short
 *  enough that going offline is noticed while somebody is watching. */
const POLL_MS = 15_000

export default function Rooms() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newHandle, setNewHandle] = useState('')
  const [label, setLabel] = useState('')
  const [live, setLive] = useState<Record<string, boolean>>({})
  // The room waiting to be deleted, rather than a boolean: the dialog names the
  // room, and naming it from the room that raised it is the one way the name on
  // screen cannot drift from the room that gets deleted.
  const [pendingDelete, setPendingDelete] = useState<Room | null>(null)
  const toast = useToast()

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
  //
  // Keyed on the room IDS rather than on `rooms`. That object is a fresh array
  // every poll, so depending on it tore this effect down and rebuilt it on every
  // tick — which restarted the interval each time and fired an immediate status
  // sweep on top of the one already in flight. The ids are a string, so the effect
  // only restarts when the set of rooms genuinely changes.
  const roomIds = rooms.map((room) => room.id).join(',')

  useEffect(() => {
    if (!roomIds) return
    let cancelled = false

    const check = async () => {
      const results = await Promise.all(
        roomIds.split(',').map(async (id) => {
          try {
            const status = await api.status(id)
            return [id, status.connected] as const
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
  }, [roomIds])

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
      const wanted = label.trim()
      if (wanted && wanted !== room.name) {
        try {
          await api.updateRoom(room.id, { name: wanted })
        } catch {
          // The stream is connected either way; a label that would not save is
          // not a reason to tell the operator the connect failed.
        }
      }
      setNewHandle('')
      setLabel('')
      setError('')
      toast(`Connected to @${handle}.`)
      // A room that was just created is not in the list yet, so this cannot
      // wait for the next poll to show the streamer's own room.
      setRooms((current) => (current.some((r) => r.id === room.id) ? current : [room, ...current]))
    } catch (cause) {
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

  /**
   * Delete the room the dialog is asking about.
   *
   * The room is taken from `pendingDelete` rather than from an argument, so what
   * gets deleted is what the dialog named — the same object, not a name that was
   * re-read from a list that a poll may have refreshed in between.
   */
  const confirmRemove = async () => {
    const room = pendingDelete
    if (!room) return
    setBusy(true)
    try {
      await api.deleteRoom(room.id)
      await load()
      setPendingDelete(null)
      toast(`Deleted “${room.name || room.username || 'room'}”. Its overlay link no longer works.`)
    } catch (cause) {
      // Same treatment as create: a refused token and a backend that is down are
      // different problems, and the raw "Invalid or missing STREAMKIT_TOKEN" says
      // nothing about which one happened or what to do about it.
      setPendingDelete(null)
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
          <p className="muted">
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
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            aria-label="Room label"
          />
          <button className="primary" onClick={() => void connect()} disabled={busy || newHandle.trim() === ''}>
            Connect
          </button>
        </div>
        <p className="faint tight-caption">
          The room is created for you and starts watching straight away — a stream that is not live yet is fine,
          it connects when it goes live. Connecting a handle that already has a room reuses it and keeps its
          styling.
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
                  {/* A room connected without a label has an empty name, and an
                      empty heading beside the status badge reads as broken data
                      rather than as "nobody named this". The handle is the thing
                      the streamer will recognise, so it stands in. */}
                  {room.name || room.username || 'unnamed room'}{' '}
                  <span className={live[room.id] ? 'badge live' : 'badge off'}>{live[room.id] ? 'live' : 'not connected'}</span>
                </div>
                <div className="faint mono">{room.username || 'no handle connected yet'}</div>
              </div>
              {/* A link, not a button: the builder's address is the style, and a
                  style you cannot send to somebody is not much of a style. The
                  room travels in the query string rather than in state, so the
                  back button comes back here rather than to the tab that happened
                  to be open. */}
              <Link className="btn" href={`/admin/overlay?room=${encodeURIComponent(room.id)}`}>
                Style the overlay
              </Link>
              <button
                className="danger"
                onClick={() => setPendingDelete(room)}
                disabled={busy}
                aria-label={`Delete ${room.name}`}
              >
                Delete
              </button>
            </div>
          </div>
        ))
      )}

      {/* One dialog for the list, not one per row: it is a single question at a
          time, and a dialog per room would put a <dialog> in the DOM for every
          row on the page. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this room?"
        body={
          <>
            <p className="flush-top">
              <strong>{pendingDelete?.name || pendingDelete?.username || 'This room'}</strong> will be removed
              from the backend.
            </p>
            {/* The consequence, stated plainly: this is the whole reason the
                question is asked, and it is what the browser's own dialog could
                not say — it offered "OK". */}
            <p className="muted flush-top">
              Its overlay link stops working immediately. Anything you have pasted into OBS will go blank until
              you point it at another room.
            </p>
          </>
        }
        confirmLabel="Delete room"
        busy={busy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}