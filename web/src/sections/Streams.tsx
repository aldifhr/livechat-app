/**
 * The operator's streams.
 *
 * This used to be a list of rows: handle, a badge, and two buttons. The link that
 * actually goes into OBS was two clicks away, inside the builder, on a page showing
 * one room at a time. For somebody with more than one stream that was the whole
 * cost of the product: to answer "which link goes on this scene" you had to go and
 * find out.
 *
 * So a stream is a card here, and it carries everything about that stream in one
 * place — both links, both copy buttons, whether it is live right now — and styling
 * is the one thing that needs its own page. The terminal action of this product is
 * copying a link, so it should not be behind anything.
 */

'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, isAuthFailure } from '../lib/client'
import { useOrigin } from '../lib/browser'
import type { Room, RoomSession } from '../lib/types'
import CopyField from '../components/CopyField'
import ConfirmDialog from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'

/** How often to ask about a room's live state. Long enough to be quiet, short
 *  enough that going offline is noticed while somebody is watching. */
const POLL_MS = 15_000

/** What one stream looks like on the card. */
function StreamCard({
  room,
  live,
  session,
  busy,
  onDelete,
}: {
  room: Room
  live: boolean | undefined
  session: RoomSession | undefined
  busy: boolean
  onDelete: (room: Room) => void
}) {
  // Just the room. The styling lives on the room and reaches the overlay over the
  // socket, so a link pasted into OBS keeps working across every restyle — which
  // was the whole reason for carrying it in the query string in the first place,
  // solved properly this time.
  const chatUrl = api.chatOverlay(room.id)
  const studioChatUrl = api.chatOverlay(room.id, 'studio')
  const boardUrl = api.topChatterOverlay(room.id)

  return (
    <article className="stream-card">
      <header className="stream-head">
        <div className="grow">
          {/* The handle is the name. A label is what the operator chose to call it,
              and the handle is what the streamer recognises — so the handle leads and
              the label sits under it, rather than the same text twice in two fonts. */}
          <h3 className="stream-name">
            @{room.username || 'no handle'}
            {live === undefined ? null : (
              <span className={live ? 'badge live' : 'badge off'}>{live ? 'live' : 'offline'}</span>
            )}
          </h3>
          {room.name && room.name !== room.username && <p className="faint stream-label">{room.name}</p>}
        </div>
      </header>

      <div className="stream-links">
        <p className="copy-label">3. OBS browser source links</p>
        <CopyField label="Chat overlay · Original" url={chatUrl} />
        <CopyField label="Chat overlay · Studio" url={studioChatUrl} />
        <CopyField label="Top chatters" url={boardUrl} />
      </div>

      {session && <SessionPanel session={session} />}

      <footer className="stream-actions">
        <Link className="btn" href={`/admin/overlay?room=${encodeURIComponent(room.id)}`}>
          2. Style overlay
        </Link>
        <button className="danger" onClick={() => onDelete(room)} disabled={busy}>
          Delete
        </button>
      </footer>
    </article>
  )
}

/** What the page shows before there is anything to show. */
function GettingStarted() {
  return (
    <div className="panel getting-started">
      <h3>Nothing is connected yet</h3>
      <ol className="steps">
        <li>
          <strong>Connect a TikTok username.</strong> StreamKit starts watching it straight away — a
          stream that is not live yet is fine, it connects when it goes live.
        </li>
        <li>
          <strong>Style the overlay.</strong> Size, colours, how many messages sit on screen. It
          saves as you go, and the overlay on your stream changes with it.
        </li>
        <li>
          <strong>Add the link as a browser source in OBS.</strong> Sized to your canvas. The link
          does not change when you restyle, so this is a one-time step per stream.
        </li>
      </ol>
    </div>
  )
}

export default function Streams() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newHandle, setNewHandle] = useState('')
  const [live, setLive] = useState<Record<string, boolean>>({})
  // Each room's session counters, from `eventlog` via the session endpoint. The
  // backend already tracked peaks, diamonds and the leaderboards; this is the first
  // place any of it is shown.
  const [sessions, setSessions] = useState<Record<string, RoomSession>>({})
  // The room waiting to be deleted, rather than a boolean: the dialog names the
  // room, and naming it from the room that raised it is the one way the name on
  // screen cannot drift from the room that gets deleted.
  const [pendingDelete, setPendingDelete] = useState<Room | null>(null)
  const [loaded, setLoaded] = useState(false)
  const toast = useToast()
  // Read after mount rather than during render: a `typeof window` branch in the
  // markup is a hydration mismatch, and this is one of the three places it was.
  const origin = useOrigin()

  const load = useCallback(async () => {
    try {
      const { rooms: found } = await api.rooms()
      setRooms(found)
      setError('')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The stream list could not be loaded')
    } finally {
      setLoaded(true)
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
  // Keyed on the room ids rather than on `rooms`. That object is a fresh array every
  // poll, so depending on it tore this effect down and rebuilt it on every tick.
  const roomIds = rooms.map((room) => room.id).join(',')

  useEffect(() => {
    if (!roomIds) return
    let cancelled = false

    const check = async () => {
      const results = await Promise.all(
        roomIds.split(',').map(async (id) => {
          try {
            // Status and session together, in one pass. They are two reads of the
            // same room and the card shows them side by side, so fetching them
            // separately would let the badge and the numbers describe two
            // different moments.
            const [status, session] = await Promise.all([api.status(id), api.session(id)])
            return [id, status.connected, session] as const
          } catch {
            // A status that cannot be read is not evidence the room is down, so
            // the room keeps whatever it last showed. Reporting it as offline
            // would be a guess dressed as a reading.
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
      setSessions((current) => {
        const next = { ...current }
        for (const entry of results) if (entry) next[entry[0]] = entry[2]
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
      await api.connectHandle(handle)
      setNewHandle('')
      setError('')
      toast(`Connected to @${handle}.`)
      // Re-read rather than pushing the connect answer in.
      //
      // It used to splice the answer straight onto the list so a room created
      // one second earlier did not wait for the next poll. But that answer is not
      // a room: it carries room_id and a status, not id and config, and
      // splicing it produced an entry whose id was undefined - which React
      // reports as a list child with no key, long after anyone was looking for
      // it. One read costs the same round trip the splice was avoiding.
      void load()
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
      toast(`Deleted @${room.username || room.name || 'stream'}. Its overlay links stop working.`)
    } catch (cause) {
      setPendingDelete(null)
      setError(
        cause instanceof ApiError && isAuthFailure(cause.status)
          ? 'Your login was refused. Reload the page and sign in again.'
          : cause instanceof ApiError
            ? cause.message
            : 'The stream could not be deleted',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Streams</h2>
          <p className="muted">
            Connect a TikTok username, style its overlay, then copy a browser source link into OBS.
          </p>
          {/* The origin is on every one of these links and is the same on all of
              them, so the field scrolls to the end of the URL where the part that
              differs actually is. Saying where they point once is cheaper than
              repeating it on every card. */}
          <p className="faint mono stream-origin">{origin}</p>
        </div>
        <div className="actions">
          <button onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="panel">
        <h3>1. Connect a stream</h3>
        <div className="row">
          <input
            className="grow"
            placeholder="TikTok username — with or without the @"
            value={newHandle}
            onChange={(event) => setNewHandle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void connect()}
            aria-label="TikTok username"
          />
          <button
            className="primary"
            onClick={() => void connect()}
            disabled={busy || newHandle.trim() === ''}
          >
            Connect
          </button>
        </div>
        <p className="faint tight-caption">
          Connecting a handle that already has a room reuses it and keeps its styling.
        </p>
      </div>

      {loaded && rooms.length === 0 ? (
        <GettingStarted />
      ) : (
        <div className="stream-grid">
          {rooms.map((room) => (
            <StreamCard
              key={room.id}
              room={room}
              live={live[room.id]}
              session={sessions[room.id]}
              busy={busy}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      {/* One dialog for the list, not one per card: it is a single question at a
          time, and a dialog per stream would put a <dialog> in the DOM for every
          card on the page. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this stream?"
        body={
          <>
            <p className="flush-top">
              <strong>@{pendingDelete?.username || pendingDelete?.name || 'This stream'}</strong> will
              be removed from the backend.
            </p>
            {/* The consequence, stated plainly: this is the whole reason the
                question is asked, and it is what the browser's own dialog could
                not say — it offered "OK". */}
            <p className="muted flush-top">
              Its overlay links stop working immediately. Anything you have pasted into OBS will go
              blank until you point it at another stream.
            </p>
          </>
        }
        confirmLabel="Delete stream"
        busy={busy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

/**
 * What this session has produced, on the stream's own card.
 *
 * Every number here was already tracked by the backend and reachable from
 * nowhere: the card showed a live/offline badge and nothing else, while `eventlog`
 * accumulated peaks, diamonds and two leaderboards behind an endpoint with no
 * caller. This is that data with a door on it.
 *
 * Hidden entirely when nothing has happened. A card for a room that has never
 * connected would otherwise carry a grid of zeroes, which reads as a broken
 * stream rather than an idle one.
 */
function SessionPanel({ session }: { session: RoomSession }) {
  const events = Object.values(session.totals).reduce((sum, n) => sum + n, 0)
  const idle = !session.connected && events === 0 && session.total_diamonds === 0
  if (idle) return null

  return (
    <div className="session">
      <p className="copy-label">This session</p>
      <dl className="session-grid">
        <Stat label="Live for" value={duration(session.live_seconds)} />
        <Stat label="Peak viewers" value={session.peak_viewers ? session.peak_viewers.toLocaleString() : '—'} />
        <Stat label="Diamonds" value={session.total_diamonds ? session.total_diamonds.toLocaleString() : '—'} />
        <Stat label="Events" value={events ? events.toLocaleString() : '—'} />
      </dl>
      {/* Only the leaders that exist. An empty list renders nothing rather than a
          heading over a gap. */}
      <Leaders label="Top chatters" people={session.topChatters} unit="messages" />
      <Leaders label="Top gifters" people={session.topGifters} unit="diamonds" />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function Leaders({ label, people, unit }: { label: string; people: RoomSession['topChatters']; unit: string }) {
  const top = people.slice(0, 3)
  if (top.length === 0) return null
  return (
    <p className="session-leaders">
      <span className="faint">{label}:</span>{' '}
      {top.map((person, index) => (
        <span key={person.id}>
          {index > 0 && ', '}
          <strong>{person.nickname}</strong>{' '}
          <span className="faint">
            {(person[unit === 'messages' ? 'messages' : 'diamonds'] ?? 0).toLocaleString()} {unit}
          </span>
        </span>
      ))}
    </p>
  )
}

/** Seconds as something readable, or an em dash when there is no session. */
function duration(seconds: number | null): string {
  if (!seconds) return '—'
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
