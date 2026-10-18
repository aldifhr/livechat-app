/**
 * The browser's way of asking for something.
 *
 * Every call goes to this app's own `/api/backend` route, which attaches the
 * token on the server. There is no token in this file, in `NEXT_PUBLIC_` anything,
 * or anywhere else the browser could read one — the credential lives in the
 * server's environment and stops here.
 *
 * The route is behind the session gate, so a call made with no session is
 * answered with a redirect to the login page rather than with data. `isAuthFailure`
 * treats that as it treats any refused credential, which is what the caller wants:
 * "sign in again", not "the backend broke".
 */

'use client'

import type { AnalyticsSummary, GiveawaySnapshot, LogPage, Room, RoomSession, RoomStatus } from '../types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Whether a status means the credential was refused rather than the call
 *  failing. Both mean "try again differently" but the fix is different. */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403
}

const BASE = '/api/backend'

type Query = Record<string, string | number | boolean | undefined>

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      // A hung backend must not leave the page spinning forever. Ten seconds is
      // well above any normal API call on this dashboard, and the catch below
      // turns the AbortError into the same "could not be sent" the network
      // failure path already produces.
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : 'The request could not be sent')
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string }
    throw new ApiError(response.status, payload.detail ?? `${method} ${path} failed`)
  }
  return (await response.json()) as T
}

/**
 * The overlay links as this app serves them.
 *
 * Read from the page itself rather than a build-time constant, so a deployment
 * that moves the frontend domain does not have to rebuild for the links handed
 * to OBS to be right.
 */
const origin = typeof window === 'undefined' ? '' : window.location.origin

/**
 * An overlay link.
 *
 * The room and nothing else. This used to carry the whole style in the query string
 * — about 250 characters for an unstyled room, most of it the default font stack,
 * URL-encoded — because the styling had nowhere else to live and a link that
 * described itself was the honest description of what OBS was pointed at.
 *
 * It lives in the room's saved config now, and a running overlay is told about a
 * change over the socket it already holds open. So the link says which room it is
 * for and the room says how it looks: paste it into OBS once and restyling the
 * stream never touches it again.
 */
function overlayUrl(path: string, id: string): string {
  const url = new URL(path, origin)
  url.searchParams.set('room', id)
  return url.toString()
}

/**
 * What connecting a handle actually answers with.
 *
 * Not a `Room`, and that is the point of naming it. `/api/room-connect-by-username`
 * starts a connection and hands back `{ room_id, status, username, connected, ... }` —
 * there is no `id`, no `name`, no `config` in it. It was typed as `Room` anyway,
 * because `Room` is the shape the rest of this file speaks in, and the lie stayed
 * invisible until a caller believed it: the stream list pushed the answer in as a
 * room, `room.id` was `undefined`, and React reported that children in a list had
 * no key. Nothing broke by accident — the answer simply was not the thing its type
 * claimed.
 *
 * So the type says what arrives, and a caller that needs a `Room` re-reads the list
 * rather than dressing this up as one.
 */
export interface ConnectResult {
  room_id: string
  status: string
  username?: string
  connected?: boolean
  message?: string
  liveEnded?: boolean
}

/**
 * What a stop answers with.
 *
 * `{ status: "disconnected" }` and nothing else — no room, no status snapshot. The
 * consequence for a caller is that it cannot learn anything from the reply: whether
 * the stop did anything is not in it, so a page re-reads the room's own status
 * rather than reading a field that says "ok" either way.
 */
export interface DisconnectResult {
  status: string
}

export const api = {
  rooms: () => request<{ rooms: Room[] }>('GET', '/rooms'),
  status: (id: string) => request<RoomStatus>('GET', `/rooms/${id}/status`),
  connectHandle: (username: string) =>
    request<ConnectResult>('POST', '/room-connect-by-username', { username }),
  /**
   * Point a room at the handle its own config already names.
   *
   * Typed as the connect envelope it actually is, not as a `Room`. It was typed as
   * one for as long as the method sat uncalled, and that was the whole of the bug
   * `ConnectResult` exists to document: the answer carries `room_id` and a status,
   * never `id`, `name` or `config`, so a caller trusting the type reads
   * `undefined` off a field that is not there. Both connect routes answer the same
   * shape, so both are typed the same way.
   */
  connectRoom: (id: string) => request<ConnectResult>('POST', `/room-connect/${id}`),
  /**
   * Stop watching a room, without deleting it or forgetting its handle.
   *
   * What it does *not* do is worth knowing before the button exists: the room's
   * stored username is untouched, so a backend restart re-aims it at that handle
   * again through `restore_sources`. A stop is a pause until the next boot, not a
   * decision the store keeps.
   */
  disconnect: (id: string) => request<DisconnectResult>('POST', '/disconnect', { room_id: id }),
  updateRoom: (id: string, change: { name?: string; username?: string }) =>
    request<Room>('PATCH', `/rooms/${id}`, change),
  deleteRoom: (id: string) => request<null>('DELETE', `/rooms/${id}`),

  /**
   * Save a room's overlay styling.
   *
   * `base` is the room's config as it was last read, and it matters: the store
   * replaces a room's whole config rather than merging into it, so sending only
   * the fields being changed would drop the other overlay's settings. The caller
   * spreads its own fields over the config it already had, which is the only way
   * to save one overlay without erasing the other.
   *
   * The backend broadcasts what was stored to every overlay already watching that
   * room, so a style reaches OBS without the link being copied again.
   */
  saveStyle: (id: string, base: Record<string, unknown>, fields: Record<string, unknown>) =>
    request<{ status: string }>('POST', `/rooms/${id}/config`, { config: { ...base, ...fields } }),

  // One URL per overlay so a customiser or a scene collection points at
  // exactly one page. The bare /overlay path still redirects, for links pasted
  // before the split.
  chatOverlay: (id: string, design: 'original' | 'studio' = 'original') => {
    const url = new URL(overlayUrl('/overlay/chat-overlay', id))
    if (design === 'studio') url.searchParams.set('design', 'studio')
    return url.toString()
  },
  catOverlay: (id: string) => overlayUrl('/overlay/cat-overlay', id),
  topChatterOverlay: (id: string) => overlayUrl('/overlay/top-chatter', id),
  likeTargetOverlay: (id: string) => overlayUrl('/overlay/like-target', id),
  giveawaySnapshots: () => request<{ snapshots: GiveawaySnapshot[] }>('GET', '/giveaways/snapshots'),
  /** Unpublish a snapshot, so its public link stops resolving. Irreversible. */
  deleteGiveawaySnapshot: (id: string) =>
    request<{ status: string }>('DELETE', `/giveaways/snapshots/${id}`),


  /**
   * The backend's recent log records.
   *
   * `level` is a floor, not a match: `warning` returns warnings, errors and
   * criticals. The backend clamps `limit` and falls back to `info` for a level it
   * does not know, so a mistyped filter answers with the default view rather than
   * an error.
   */
  logs: (opts: { limit?: number; level?: string; q?: string } = {}) =>
    request<LogPage>('GET', '/logs', undefined, {
      limit: opts.limit,
      level: opts.level,
      q: opts.q,
    }),
  analytics: () => request<AnalyticsSummary>('GET', '/analytics'),

  /** What this room's current session has accumulated — peaks, diamonds, leaders. */
  session: (id: string) => request<RoomSession>('GET', `/rooms/${id}/session`),
  publicRooms: () => request<{ rooms: Array<{ id: string; username: string; name: string; connected: boolean }> }>('GET', '/rooms/public'),
}
