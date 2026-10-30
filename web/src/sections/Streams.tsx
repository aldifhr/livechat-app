/**
 * The operator's streams.
 *
 * This used to be a list of rows, then a grid of cards, and each of those was an
 * attempt to answer "which link goes on this scene" without opening anything. The
 * cards did answer it — they carried every OBS link and a copy button each — and the
 * cost was that a grid of them is mostly monospace, one room id per card, and a
 * screen of streams you have to scroll to find the end of.
 *
 * So the grid is gone and each stream is a row: the handle, whether it is live, how
 * many are watching. That is what an operator scans this page for — which of my
 * streams is running — and everything else lives at the row's own address now.
 *
 * A row rather than a card is the right shape for the same reason: it is a link, so
 * it can be opened, bookmarked and sent to somebody, and the back button walks out
 * of a stream rather than off the end of a grid.
 */

'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, isAuthFailure } from '../lib/client/api'
import { useOrigin } from '@/hooks/useBrowser'
import { usePoll } from '@/hooks/usePoll'
import { useConnectionWatch } from '@/hooks/useConnectionWatch'
import { profilePath } from '../lib/client/streamLinks'
import type { Room, RoomStatus } from '../lib/types'
import RoomStateBadge from '../components/RoomStateBadge'
import { Stagger, StaggerItem } from '../components/magicui/Stagger'
import { useToast } from '../components/Toast'

/** How often to ask about a room's live state. Long enough to be quiet, short
 *  enough that going offline is noticed while somebody is watching. */
const POLL_MS = 15_000

/** One line per stream: who it is, and whether it is running. */
function StreamRow({ room, status }: { room: Room; status: RoomStatus | undefined }) {
  return (
    <StaggerItem as="li">
      <Link
        className="stream-row"
        // The row already knows its platform, so the link is built from the
        // room's own record rather than from the page's scope — a mixed list
        // (which `/admin/streams` is) then links each row into its own tree.
        href={profilePath(room.username, room.id)}
      >
        <span className="stream-row-name">
          {/* Every row carries its platform label. Absent means TikTok: rooms
              created before the field existed are all TikTok, and it is the only
              platform served. */}
          <span className="faint">TikTok · </span>
          @{room.username || 'no handle'}
          <RoomStateBadge status={status} />
        </span>
        {room.name && room.name !== room.username && (
          <span className="faint stream-row-label">{room.name}</span>
        )}
        <span className="stream-row-viewers">
          {status?.connected && typeof status.viewers === 'number'
            ? `${status.viewers.toLocaleString()} watching`
            : null}
        </span>
        <span className="stream-row-go" aria-hidden="true">
          →
        </span>
      </Link>
    </StaggerItem>
  )
}

/** What the page shows before there is anything to show. */
function GettingStarted() {
  return (
    <div className="panel getting-started">
      <h3>Nothing is connected yet</h3>
      <ol className="steps">
        <li>
          <strong>Connect a TikTok username.</strong>{' '}
          StreamKit starts watching it straight away — a stream that is not live yet is fine, it
          connects when it goes live.
        </li>
        <li>
          <strong>Open the stream.</strong> Its page carries the browser source links for OBS and
          the name and handle it is filed under.
        </li>
        <li>
          <strong>Style the overlay.</strong> Size, colours, how many messages sit on screen. It
          saves as you go, and the overlay on your stream changes with it.
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
  // The whole status, not `connected`. The backend distinguishes connecting,
  // waiting and live-ended from offline, and a row that kept only the boolean
  // rendered all four as "offline" — including the seconds straight after a
  // Connect that had worked, which is the moment the badge is being watched.
  const [statuses, setStatuses] = useState<Record<string, RoomStatus>>({})
  const [loaded, setLoaded] = useState(false)
  // At a fast beat, for the seconds after a Connect. See the hook for why the
  // fifteen-second poll below is not the thing to watch that with.
  const watchConnection = useConnectionWatch((id, status) =>
    setStatuses((current) => ({ ...current, [id]: status })),
  )
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

  usePoll(load, POLL_MS)

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
            const status = await api.status(id)
            return [id, status] as const
          } catch {
            // A status that cannot be read is not evidence the room is down, so
            // the room keeps whatever it last showed. Reporting it as offline
            // would be a guess dressed as a reading.
            return null
          }
        }),
      )
      if (cancelled) return
      setStatuses((current) => {
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
    // One stream only. The form is hidden once a room exists, but the guard
    // lives here too: the form is not the rule, it is a picture of the rule, and
    // a second room must not be creatable by a stale tab or a replayed request.
    if (rooms.length > 0) {
      setError('This dashboard runs one stream. Disconnect the current one before adding another.')
      return
    }
    setBusy(true)
    try {
      const answer = await api.connectHandle(handle, 'tiktok')
      setNewHandle('')
      setError('')
      // What the request actually said. `connecting` is the normal answer for a
      // handle that is going to work — the adapter connects after this returns —
      // so announcing "Connected" here was claiming something the response had
      // not said yet, and the row contradicting it a moment later.
      toast(
        answer.status === 'already-connected'
          ? `@${handle} was already connected.`
          : `Connecting to @${handle}…`,
      )
      // Re-read rather than pushing the connect answer in.
      //
      // It used to splice the answer straight onto the list so a room created
      // one second earlier did not wait for the next poll. But that answer is not
      // a room: it carries room_id and a status, not id and config, and
      // splicing it produced an entry whose id was undefined - which React
      // reports as a list child with no key, long after anyone was looking for
      // it. One read costs the same round trip the splice was avoiding.
      void load()
  // The answer names the room, so the row that just appeared can be watched at a
  // beat worth watching rather than at this page's fifteen seconds.
  void watchConnection(answer.room_id, handle)
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

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Streams</h2>
          <p className="muted">
            Connect your TikTok username, style its overlay, then copy a
            browser source link into OBS.
          </p>
          {/* The origin is on every one of this page's links and is the same on all
              of them, so the field scrolls to the end of the URL where the part that
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

      {/* One stream only. This dashboard is a personal console, so the connect
          form is shown while there is nothing connected and hidden the moment
          there is — a second stream is not a feature here, it is a mistake the
          form would otherwise invite. The row it already has is the way back to
          it. */}
      {rooms.length === 0 && (
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
      )}

      {loaded && rooms.length === 0 ? (
        <GettingStarted />
      ) : (
        <Stagger as="ul" className="stream-list">
          {rooms.map((room) => (
            <StreamRow key={room.id} room={room} status={statuses[room.id]} />
          ))}
        </Stagger>
      )}
    </>
  )
}
