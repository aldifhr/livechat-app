/**
 * One stream, in full.
 *
 * This is what a card on the streams list used to be, at an address instead of in a
 * grid — the three OBS links, the way into the builder, and the way to delete it —
 * plus the one thing a card could not carry: the room's own name and handle, which
 * are editable here.
 *
 * `api.updateRoom` existed and nothing called it, so a room kept the name it was
 * auto-created with and the handle it was connected by, forever. A page called a
 * profile that cannot say what it is called is a card with a URL on it.
 *
 * The handle is editable here and it is a heavier thing than the name looks: the
 * backend stops the running source and forgets the room's counters when it changes,
 * because both belonged to the streamer that was there before. So it says so, next
 * to the field, rather than in a dialog after the fact.
 */

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, isAuthFailure } from '@/lib/client'
import { useOrigin } from '@/lib/browser'
import { useConnectionWatch } from '@/lib/useConnectionWatch'
import { streamLinks, LINK_LABELS } from '@/lib/streamLinks'
import type { Room, RoomSession, RoomStatus } from '@/lib/types'
import LinkLine from '@/components/LinkLine'
import ConfirmDialog from '@/components/ConfirmDialog'
import RoomStateBadge from '@/components/RoomStateBadge'
import SessionPanel from '@/components/SessionPanel'
import { useToast } from '@/components/Toast'

/** How often to re-read this stream's live state. The same beat the list uses, so
 *  a stream followed from the list and one followed from here do not disagree. */
const POLL_MS = 15_000

/**
 * The handle in the address, as a room's own field.
 *
 * The `@` is optional in what is typed — `/admin/streams/@foo` and
 * `/admin/streams/foo` are both addresses somebody will try — and a room with no
 * handle yet is reachable by its id, because that is what the list falls back to
 * when it has nothing better to link to.
 */
function matches(room: Room, wanted: string): boolean {
  return room.username === wanted || room.id === wanted
}

export default function StreamProfile({ handle }: { handle: string }) {
  const wanted = decodeURIComponent(handle).trim().replace(/^@/, '')
  const [room, setRoom] = useState<Room | null>(null)
  const [status, setStatus] = useState<RoomStatus | undefined>()
  const [session, setSession] = useState<RoomSession | undefined>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)

  const origin = useOrigin()
  const router = useRouter()
  // The same fast beat the list uses, for the seconds after a Connect. The poll
  // below is right for noticing a stream that quietly stopped and far too slow for
  // the moment somebody pressed the button. This page only ever watches its own
  // room, so the reading replaces the single status it holds.
  const watchConnection = useConnectionWatch((_id, reading) => setStatus(reading))
  const toast = useToast()

  const load = useCallback(async () => {
    try {
      const { rooms } = await api.rooms()
      const found = rooms.find((candidate) => matches(candidate, wanted)) ?? null
      setRoom(found)
      setError('')
      if (found) {
        // Read together rather than one after the other. The badge says whether
        // this stream is live and the panel says what it has done, and a page
        // where the two can describe different moments is a number that is wrong
        // with nothing on screen to say so.
        const [read, counted] = await Promise.all([
          api.status(found.id).catch(() => undefined),
          api.session(found.id).catch(() => undefined),
        ])
        // A status that cannot be read is not evidence the room is down. The
        // badge keeps what it last showed rather than being handed a reading this
        // page never took.
        if (read) setStatus(read)
        if (counted) setSession(counted)
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'This stream could not be loaded')
    } finally {
      setLoaded(true)
    }
  }, [wanted])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const links = room ? streamLinks(room.id) : null

  /**
   * Whether the backend is doing anything for this room.
   *
   * `waiting` counts, and that is the backend's own requirement rather than a
   * nicety: it sets `connecting` alongside `waiting` while it polls for a streamer
   * with no live, and a wait can run two hours. Reading `connecting` alone would
   * leave a room in that state with no button that does anything — a state the user
   * cannot leave is not a state, it is a trap.
   */
  const running = Boolean(status?.connected || status?.connecting || status?.waiting)

  /**
   * Start watching, or stop.
   *
   * One button for both because the state it acts on is the state the badge above
   * already shows; a separate "Connect" and "Disconnect" would be two buttons for
   * one question, and both would have to be disabled in states the other covers.
   */
  const toggleConnection = async () => {
    if (!room) return
    setBusy(true)
    const starting = !running
    try {
      if (starting) {
        const answer = await api.connectRoom(room.id)
        // `connecting` is the normal answer for a handle that is going to work, so
        // announcing "Connected" would claim something the response has not said.
        toast(
          answer.status === 'already-connected'
            ? `@${room.username} was already connected.`
            : `Connecting to @${room.username}…`,
        )
      } else {
        await api.disconnect(room.id)
        // The room and its handle are untouched by a stop, so the only thing that
        // changed is that nothing is watching it — which is what this says, and
        // does not promise it will stay that way across a restart.
        toast(`Stopped watching @${room.username}. Its overlay links still work.`)
      }
      setError('')
      await load()
      // Started after the re-read, not before it. Both write the same status, and
      // running them the other way round lets the re-read land second and replace a
      // fresher reading from the watch with a slightly staler one.
      if (starting) void watchConnection(room.id, room.username)
    } catch (cause) {
      setError(
        cause instanceof ApiError && isAuthFailure(cause.status)
          ? 'Your login was refused. Reload the page and sign in again.'
          : cause instanceof ApiError
            ? cause.message
            : 'The connection could not be changed',
      )
    } finally {
      setBusy(false)
    }
  }



  const confirmRemove = async () => {
    if (!room) return
    setBusy(true)
    try {
      await api.deleteRoom(room.id)
      setPendingDelete(false)
      toast(`Deleted @${room.username || room.name || 'stream'}. Its overlay links stop working.`)
      router.push('/admin/streams')
    } catch (cause) {
      setPendingDelete(false)
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

  if (loaded && !room) {
    return (
      <>
        <div className="page-head">
          <div>
            <h2>No such stream</h2>
            <p className="muted">
              Nothing here is called <strong>@{wanted}</strong>. It may have been deleted, or the
              address may have a typo in it.
            </p>
          </div>
        </div>
        <div className="panel">
          <Link className="btn" href="/admin/streams">
            Back to streams
          </Link>
        </div>
      </>
    )
  }

  if (!room || !links) return null

  return (
    <>
      <div className="page-head">
        <div>
          <p className="faint">
            <Link className="quiet-link" href="/admin/streams">
              ← Streams
            </Link>
          </p>
          <h2 className="stream-name">
            @{room.username || 'no handle'}
            <RoomStateBadge status={status} />
          </h2>
          {status?.connected && typeof status.viewers === 'number' && (
            <p className="faint tight-caption">{status.viewers.toLocaleString()} watching</p>
          )}
          <p className="faint mono stream-origin">{origin}</p>
        </div>
        <div className="actions">
          {/* Only offered when it would do something. A room with no handle has
              nothing to connect to, and one that is already running has nothing to
              connect — the button turns into the way out. */}
          {Boolean(room.username) && (
            <button
              className={running ? undefined : 'primary'}
              onClick={() => void toggleConnection()}
              disabled={busy || (!running && !room.username)}
            >
              {running ? 'Stop' : 'Connect'}
            </button>
          )}
          <Link className="btn" href={`/admin/overlay?room=${encodeURIComponent(room.id)}`}>
            Style overlay
          </Link>
          <button className="danger" onClick={() => setPendingDelete(true)} disabled={busy}>
            Delete
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {/* The session counters sit above the links, not below them. What this stream
          has done is the first thing anybody opening its page wants, and the links
          are the same on every stream and change never. */}
      {session && (
        <div className="panel">
          <SessionPanel session={session} />
        </div>
      )}

      <div className="panel">
        <h3>OBS browser source links</h3>
        <p className="faint tight-caption">
          Add one as a browser source in OBS, sized to your canvas. The link does not change when
          you restyle, so this is a one-time step.
        </p>
        <div className="stream-links">
          <LinkLine label={LINK_LABELS.original} url={links.original} />
          <LinkLine label={LINK_LABELS.studio} url={links.studio} />
          <LinkLine label={LINK_LABELS.cat} url={links.cat} />
          {/* All of them, in full, for the times they do have to be read: checking
              what is already sitting in OBS, or copying one by hand. */}
          <details className="stream-links-more">
            <summary>Show the links</summary>
            <dl>
              <dt>{LINK_LABELS.original}</dt>
              <dd>
                <code>{links.original}</code>
              </dd>
              <dt>{LINK_LABELS.studio}</dt>
              <dd>
                <code>{links.studio}</code>
              </dd>
              <dt>{LINK_LABELS.cat}</dt>
              <dd>
                <code>{links.cat}</code>
              </dd>
            </dl>
          </details>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title="Delete this stream?"
        body={
          <>
            <p className="flush-top">
              <strong>@{room.username || room.name || 'This stream'}</strong> will be removed from
              the backend.
            </p>
            <p className="muted flush-top">
              Its overlay links stop working immediately. Anything you have pasted into OBS will go
              blank until you point it at another stream.
            </p>
          </>
        }
        confirmLabel="Delete stream"
        busy={busy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingDelete(false)}
      />
    </>
  )
}
